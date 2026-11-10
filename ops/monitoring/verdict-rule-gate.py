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

── THE LIVE RULE, THE STRADDLE AND THE FREEZE (SIGNAL-VERDICT-RULE-GATE-LIVE-RULE-W1) ─────────────
LIVE   Each run MEASURES the live assignment per timeframe from the rows actually served — the latest
       trend-decisive row per cell in the last LIVE_LOOKBACK_DAYS, through the same one-row predicate
       `incumbent()` uses (`served_rule`). Never a copy of src/lib/verdict-rule-assignment.ts, so the
       kill switch and a rollback read true. A cell with no row reads `?`, and UNKNOWN NEVER
       SUPPRESSES A PAGE.
STRADDLE  At a window's look the live rule (`live_at_look`) is compared with the window's incumbent:
       `y` when a known cell differs, else `?` when a cell is unknown, else `n`. On a straddled window
       the registration still tests against the OLD incumbent, so its verdict is no action (the
       2026-10-31 straddle ruling): a SWITCH_TO the live rule is a confirmation, KEEP or another
       SWITCH_TO tests nothing against the live rule.
ACTIONABLE  Stamped ONCE per run by `evaluate_run`: rec == SWITCH_TO and straddle != y and the
       recommended assignment != the live one. `fold`, `page_keys`, `page_body`, the printed `page=`
       flag and the record all read that one field.
FREEZE A decided window is judged ONCE, at its look. Its whole Holm family — incumbent, live_at_look,
       straddle, rec, cause, statistics — is written to the ledger (VRG_LEDGER) atomically BEFORE any
       print, record or page, and a frozen look is never read, guarded or re-evaluated again. `live`
       and `actionable` are per run and never stored. The ledger is seeded once from the vault's
       union results file (`--seed-ledger`); absent, unreadable, wrong-schema or unwritable ⇒ the run
       is INDETERMINATE, never an empty ledger.

── VERDICT CONTRACT ─────────────────────────────────────────────────────────────────────────────
Exactly one terminal line: `VERDICT_RULE_GATE_VERDICT=PASS|FAIL|INDETERMINATE`, exit 0/0/3 — the
sibling convention (`trend-mode-readout-gate.py`), 3 being the token-law default for a new gate.
  FAIL           ≥ 1 decided window is ACTIONABLE — the page IS the action, so it exits 0;
  PASS           none is actionable and ≥ 1 decided window reads SWITCH_TO or KEEP_INCUMBENT;
  INDETERMINATE  nothing evaluable (every window open, underpowered, WATCH) or unreadable input.
"Measured and clean" never shares an output with "measured nothing". The line before the token is
`VERDICT_RULE_GATE_PAGE_KEYS=<comma list|none>` on every run that evaluated.

── PAGING ───────────────────────────────────────────────────────────────────────────────────────
`VERDICT_RULE_SWITCH_RECOMMENDED`, CRITICAL_PERSISTENT, through the wrapper's PAGE-ON-CHANGE
(the alert-registry row opts in): every FAIL run sends ALERT_KEYS = one `<tf>:<UP><DOWN>:w<k>` per
ACTIONABLE timeframe, so the operator is paged once per transition INTO a switch away from the live
rule; a PASS run calls `--clear` (silent). Never pages on KEEP, on a confirmation or on a straddled
window, never with empty keys (that would be a LEVEL page), and never clears while blind.

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
  VRG_LEDGER        the decided-window ledger (default /var/lib/algovault-monitoring/verdict-rule-gate-decided.json)

  verdict-rule-gate.py               run
  verdict-rule-gate.py --self-test   hermetic, two-way, mutation-proven
  verdict-rule-gate.py --show-config the registered parameters as JSON (pinned by a repo test)
  verdict-rule-gate.py --seed-ledger --records <path|->
                                     create the ledger ONCE from gate result records (create-only);
                                     VERDICT_RULE_LEDGER_SEED_VERDICT=PASS|FAIL|INDETERMINATE, exit 0/1/3.
                                     Re-seed after a loss: pipe the vault's `Claude files/canary-results.jsonl`
                                     gate lines to it on signal-1.
"""
from __future__ import annotations

import importlib.util
import io
import json
import math
import os
import random
import re
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
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
# ~46.8k buffer hits per row, 38–96 minutes per decided window of the database the product serves
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

# ── The live rule (SIGNAL-VERDICT-RULE-GATE-LIVE-RULE-W1 CH1 R1) — NOT a registered parameter, so
# `--show-config` does not carry it. The latest trend-decisive served row per (timeframe, cell) in the
# last 14 days, the emitted arm only (no outcome column, no withheld store). Measured on prod
# 2026-11-10 under the gate's PGOPTIONS: 1,028 ms cold / ~300 ms warm, every registered cell present.
LIVE_LOOKBACK_DAYS = 14
LIVE_SQL = """SELECT DISTINCT ON (ssi.timeframe, ssi.regime) ssi.timeframe, ssi.regime, ssi.signal, ssi.verdict_m, ssi.verdict_f
FROM signal_scorer_inputs ssi
WHERE ssi.decided_at >= :since AND ssi.decided_at < :at AND ssi.trend_decisive
  AND ssi.regime IN ('TRENDING_UP','TRENDING_DOWN') AND ssi.exchange <> 'BITMART' AND ssi.rule_config_id IS NOT NULL
ORDER BY ssi.timeframe, ssi.regime, ssi.decided_at DESC, ssi.scorer_input_id DESC;"""
SIDES = ("BUY", "SELL")
UNKNOWN = "?"
RULE_CHARS = ("M", "F", UNKNOWN)

# ── The freeze (CH1 R4). One ledger, keyed by look epoch; every family as it stood at its look.
LEDGER_DEFAULT = "/var/lib/algovault-monitoring/verdict-rule-gate-decided.json"
LEDGER_SCHEMA = 1
PER_RUN_FIELDS = ("live", "actionable")     # never stored: a frozen look is re-judged against today
SEED_TOKEN = "VERDICT_RULE_LEDGER_SEED_VERDICT"
PAGE_KEYS_LINE = "VERDICT_RULE_GATE_PAGE_KEYS"
CLEAR_REASON = "no switch away from the live rule is recommended"


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


def served_rule(served: str, verdict_m: str, verdict_f: str) -> str:
    """THE one-row predicate, shared by `incumbent()` and `read_live()`: a decisive row was served
    under F iff its served side is the fade verdict and the fade differs from the trend verdict."""
    return "F" if served == verdict_f and verdict_f != verdict_m else "M"


def incumbent(rows: list[dict]) -> str:
    """§4: the assignment in force at the window's first row, read per cell from the served side of
    its first decisive row (served = verdict_f ⇒ F, else M). A cell with no decisive row is M — no
    variant can act on it, so its assignment cannot change any row of this window."""
    out = []
    for regime in REGIMES:
        first = next((r for r in sorted(rows, key=lambda x: x["decided_at"])
                      if r["decisive"] and r["regime"] == regime), None)
        out.append("M" if first is None else served_rule(first["served"], first["verdict_m"], first["verdict_f"]))
    return "".join(out)


def straddle(inc: str, live_at_look: str) -> str:
    """CH1 R2: `y` if a KNOWN cell of the live rule at the look differs from the window's incumbent,
    else `?` if a cell is unknown, else `n`. An unknown cell is never a match."""
    if any(l != UNKNOWN and l != i for i, l in zip(inc, live_at_look)):
        return "y"
    return UNKNOWN if UNKNOWN in live_at_look else "n"


def is_actionable(res: dict, live: str) -> bool:
    """CH1 R2 — the ONE derivation: a switch away from the live rule on a window that does not
    straddle. A live rule with an unknown cell never equals a recommendation, so it never
    suppresses a page."""
    return res.get("rec") == "SWITCH_TO" and res.get("straddle") != "y" and res.get("cause") != live


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
    """FAIL iff any decided window is ACTIONABLE; else PASS iff something was genuinely decided
    (SWITCH_TO or KEEP_INCUMBENT); else INDETERMINATE. Reads the stamped field, never `rec` alone."""
    if any(r.get("actionable") is True for r in decided):
        return FAIL
    if any(r.get("rec") in ("SWITCH_TO", "KEEP_INCUMBENT") for r in decided):
        return PASS
    return INDET


def page_keys(decided: list[dict]) -> list[str]:
    return sorted(f"{r['tf']}:{r['cause']}:w{r['k']}" for r in decided if r.get("actionable") is True)


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


# ─────────────────────────────── the live rule (CH1 R1) ────────────────────────────────────────

def render_live(sql: str, since: int, at: int) -> str:
    """Bind `:since` and `:at`. Integers only (a bool is refused too), and a non-empty interval."""
    if type(since) is not int or type(at) is not int or since >= at:
        raise Indeterminate(f"refusing to bind the live read since={since!r} at={at!r}")
    return sql.replace(":since", str(since)).replace(":at", str(at))


def parse_live(raw: list[list[str]]) -> dict[str, str]:
    """The live read's five columns -> {tf: "<UP><DOWN>"} for EVERY registered timeframe, `F`/`M`
    per cell and `?` for a cell with no row. A row of a timeframe outside the registry (1m exists)
    is ignored; anything else unparseable — a field count, a regime, a side, a duplicate cell — is
    INDETERMINATE, never skipped."""
    cells: dict[tuple[str, str], str] = {}
    for f in raw:
        if len(f) != 5:
            raise Indeterminate(f"live row has {len(f)} fields, expected 5")
        tf, regime, served, vm, vf = f
        if regime not in REGIMES or served not in SIDES or vm not in SIDES or vf not in SIDES:
            raise Indeterminate(f"unparseable live row: {'|'.join(f)[:120]}")
        if tf not in TIMEFRAMES:
            continue
        if (tf, regime) in cells:
            raise Indeterminate(f"live read returned cell {tf}|{regime} twice")
        cells[(tf, regime)] = served_rule(served, vm, vf)
    return {tf: "".join(cells.get((tf, r), UNKNOWN) for r in REGIMES) for tf in TIMEFRAMES}


def read_live(at: int) -> dict[str, str]:
    """The live assignment AS SERVED in [at − 14 d, at). Measured, never copied from the assignment."""
    return parse_live(psql(render_live(LIVE_SQL, at - LIVE_LOOKBACK_DAYS * DAY_S, at)))


# ─────────────────────────────── the ledger (CH1 R4) ───────────────────────────────────────────

_REPLACE = os.replace  # the rename seam: root ignores chmod, so the self-test fails THIS to prove a failed write


def ledger_path() -> str:
    return os.environ.get("VRG_LEDGER", LEDGER_DEFAULT)


def json_safe(x):
    """NaN/inf -> null, tuples -> lists, recursively: the ledger and the record hold strict JSON."""
    if isinstance(x, float):
        return None if (math.isnan(x) or math.isinf(x)) else x
    if isinstance(x, dict):
        return {str(k): json_safe(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [json_safe(v) for v in x]
    return x


def frozen_copy(family: list[dict]) -> list[dict]:
    """The family exactly as the ledger will hold it — so a fresh look and a reloaded one are the
    same objects by construction."""
    return json.loads(json.dumps(json_safe(family), allow_nan=False))


def check_family(look: str, family) -> None:
    if not isinstance(family, list) or not family:
        raise Indeterminate(f"ledger look {look}: family is not a non-empty list")
    for res in family:
        if not isinstance(res, dict):
            raise Indeterminate(f"ledger look {look}: a family member is not an object")
        if res.get("tf") not in TIMEFRAMES or type(res.get("k")) is not int or type(res.get("look")) is not int:
            raise Indeterminate(f"ledger look {look}: a member lacks tf/k/look")
        if str(res["look"]) != look or res.get("state") != "DECIDED":
            raise Indeterminate(f"ledger look {look}: member {res['tf']} w{res['k']} is not DECIDED at this look")
        if res.get("rec") not in ("SWITCH_TO", "KEEP_INCUMBENT", INDET) or not isinstance(res.get("cause"), str):
            raise Indeterminate(f"ledger look {look}: member {res['tf']} w{res['k']} has no rec/cause")
        inc, lal = res.get("incumbent"), res.get("live_at_look")
        if not (isinstance(inc, str) and len(inc) == 2 and set(inc) <= {"M", "F"}):
            raise Indeterminate(f"ledger look {look}: member {res['tf']} w{res['k']} incumbent {inc!r}")
        if not (isinstance(lal, str) and len(lal) == 2 and set(lal) <= set(RULE_CHARS)):
            raise Indeterminate(f"ledger look {look}: member {res['tf']} w{res['k']} live_at_look {lal!r}")
        if res.get("straddle") != straddle(inc, lal):
            raise Indeterminate(f"ledger look {look}: member {res['tf']} w{res['k']} straddle disagrees with its own fields")
        if any(f in res for f in PER_RUN_FIELDS):
            raise Indeterminate(f"ledger look {look}: member {res['tf']} w{res['k']} stores a per-run field")


def load_ledger(path: str) -> dict:
    """The ledger as written, validated. Absent, unreadable or the wrong schema is INDETERMINATE —
    NEVER an empty ledger: an empty one would re-evaluate every decided window."""
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except FileNotFoundError as exc:
        raise Indeterminate(f"ledger absent at {path} — seed it with --seed-ledger") from exc
    except (OSError, ValueError) as exc:
        raise Indeterminate(f"ledger unreadable at {path}: {type(exc).__name__}") from exc
    if not isinstance(doc, dict) or doc.get("schema_version") != LEDGER_SCHEMA or not isinstance(doc.get("looks"), dict):
        raise Indeterminate(f"ledger at {path} is not schema_version {LEDGER_SCHEMA} with a looks object")
    for look, entry in doc["looks"].items():
        if not (isinstance(look, str) and look.isdigit()) or not isinstance(entry, dict):
            raise Indeterminate(f"ledger look key {look!r} is not an epoch with an entry object")
        if not isinstance(entry.get("frozen_at"), str) or not isinstance(entry.get("source"), str):
            raise Indeterminate(f"ledger look {look}: frozen_at/source missing")
        check_family(look, entry.get("family"))
    return doc


def _write_temp(path: str, doc: dict) -> str:
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".verdict-rule-gate-decided.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, sort_keys=True, allow_nan=False, separators=(",", ":"))
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o644)
    except BaseException:
        _unlink_quiet(tmp)
        raise
    return tmp


def _unlink_quiet(p: str) -> None:
    try:
        os.unlink(p)
    except OSError:
        pass


def write_ledger(path: str, doc: dict) -> None:
    """Atomic replace (temp in the same directory, fsync, rename). Any failure is INDETERMINATE and
    leaves the previous ledger byte-identical."""
    tmp = None
    try:
        tmp = _write_temp(path, doc)
        _REPLACE(tmp, path)
        tmp = None
    except (OSError, TypeError, ValueError) as exc:
        raise Indeterminate(f"ledger write failed at {path}: {type(exc).__name__}: {str(exc)[:80]}") from exc
    finally:
        if tmp is not None:
            _unlink_quiet(tmp)


def create_ledger(path: str, doc: dict) -> bool:
    """Create-only: False when a ledger already exists (it is left untouched). `os.link` refuses an
    existing name atomically, so a concurrent writer cannot be overwritten either."""
    tmp = _write_temp(path, doc)
    try:
        os.link(tmp, path)
        return True
    except FileExistsError:
        return False
    finally:
        _unlink_quiet(tmp)


def stamp_look(family: list[dict], live_at_look: dict[str, str]) -> None:
    """Frozen at the look: the live rule then, and the straddle it implies for each member."""
    for res in family:
        res["live_at_look"] = live_at_look[res["tf"]]
        res["straddle"] = straddle(res["incumbent"], res["live_at_look"])


def _iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def _day(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def _num(x, nd=4) -> str:
    return "na" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:.{nd}f}"


def _signed(x, nd) -> str:
    return "na" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:+.{nd}f}"


def _cnt(x) -> str:
    """A count the seeded records do not carry (per-cell days) prints `na`, never `None`."""
    return "na" if x is None else str(x)


def live_fields(res: dict) -> str:
    """CH1 R3: `live=` always; on DECIDED also the frozen `live_at_look=`, `straddle=` and the
    per-run `page=`; on progress `straddle=na`."""
    out = f" live={res.get('live', 'na')}"
    if res.get("state") == "DECIDED":
        out += (f" live_at_look={res.get('live_at_look', 'na')} straddle={res.get('straddle', 'na')}"
                f" page={'y' if res.get('actionable') is True else 'n'}")
    else:
        out += " straddle=na"
    return out


def tf_line(res: dict) -> str:
    alts = " ".join(
        f"alt={a}:ident={_num(st.get('ident'), 2)}/{FLOOR_PP}"
        + (f",delta={_num(st['delta'])},p={_num(st['p'])},holm={'y' if st.get('holm') else 'n'}"
           f",mag={_num(st['mag'], 2)},veto={'y' if st.get('veto') else 'n'}" if "p" in st else "")
        for a, st in sorted(res["alts"].items()))
    diag = " ".join(f"diag={a}:ident={_num(st.get('ident'), 2)}/{FLOOR_PP}" for a, st in res["diag"].items())
    return (f"VERDICT_RULE_GATE tf={res['tf']} window={res['k']} [{_day(res['start'])},{_day(res['end'])})"
            f" look={_iso(res['look'])} state={res['state']} incumbent={res.get('incumbent', 'na')}"
            + live_fields(res)
            + f" days={res.get('clusters', 0)}/{res.get('min_clusters') or 'WATCH'}"
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
                   f" days={_cnt(c.get('days'))}/{res.get('min_clusters') or 'WATCH'} m_edge={_num(c['m_edge'])}"
                   f" n={_cnt(c.get('n'))} rec={res['rec']} cause={res['cause']}")
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
            "rec": res["rec"], "cause": res["cause"], "alts": alts,
            # CH1 R3 — the live rule this run read, the frozen one at the look, and the one derivation
            "live": res.get("live"), "live_at_look": res.get("live_at_look"),
            "straddled": {"y": True, "n": False}.get(res.get("straddle")),
            "actionable": res.get("actionable") is True}


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
        if r.get("actionable") is True:
            st = r.get("alts", {}).get(r["cause"], {})
            lines.append(f"{r['tf']}: switch {r['incumbent']} -> {r['cause']} (window {r['k']}, "
                         f"{_day(r['start'])}..{_day(r['end'])}; Δ {_signed(st.get('delta'), 4)}, p {_num(st.get('p'))}, "
                         f"Holm-rejected, magnitude {_signed(st.get('mag'), 2)} bps; live {r.get('live', 'na')})")
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


def evaluate_all(now: int, reader, pc, cps, index_guard=None, frozen: dict | None = None,
                 live_reader=None) -> tuple[list[dict], list[dict], dict[int, list[dict]]]:
    """(decided, progress, fresh): every timeframe's latest DECIDED window with its whole look family,
    its current OPEN window as progress, and {look: family} for every look THIS run evaluated.
    A look in `frozen` (the ledger's looks) is taken from it verbatim — no read, no guard, no
    re-evaluation. An unfrozen look is evaluated as the registration says, then stamped with the live
    rule AT THE LOOK. `reader(tf, window)` -> (rows, capture); `live_reader(at)` -> {tf: rule}."""
    frozen = {} if frozen is None else frozen
    chains = {tf: window_chain(tf, T_START_EPOCH, now) for tf in TIMEFRAMES}
    latest = {tf: latest_decided(c, now) for tf, c in chains.items()}
    looks = sorted({w["look"] for w in latest.values() if w is not None})
    decided, fresh = [], {}
    if index_guard is not None and any(str(lk) not in frozen for lk in looks):
        index_guard()
    for look in looks:
        members = sorted((tf, w["k"], w["start"], w["end"]) for tf, chain in chains.items()
                         for w in chain if w["look"] == look)
        if str(look) in frozen:
            family = frozen_copy(frozen[str(look)]["family"])
            held = sorted((r["tf"], r["k"], r.get("start"), r.get("end")) for r in family)
            if held != members:
                raise Indeterminate(f"ledger look {_iso(look)} holds {[(m[0], m[1]) for m in held]} but the "
                                    f"registered chain decides {[(m[0], m[1]) for m in members]} there")
        else:
            family = []
            for tf, chain in chains.items():
                for w in chain:
                    if w["look"] == look:
                        rows, capture = reader(tf, w)
                        res = evaluate_window(tf, w, rows, capture, cps, pc)
                        res["state"] = "DECIDED"
                        family.append(res)
            evaluate_family(family)
            if live_reader is None:
                raise Indeterminate(f"look {_iso(look)} is unfrozen and no live reader was given")
            stamp_look(family, live_reader(look))
            family = frozen_copy(family)
            fresh[look] = family
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
    return decided, progress, fresh


def evaluate_run(now: int, reader, pc, cps, index_guard=None, live_reader=None,
                 ledger: str | None = None) -> tuple[str, list[dict], list[dict], str | None]:
    """(verdict, decided, progress, why). ANY input the run could not read — the ledger, a refused
    index, a timed-out statement, an unparseable row, the live read — makes the WHOLE run
    INDETERMINATE: one timeframe that could not be read must never let the others fold to PASS.

    Order (CH1 R4): load the ledger; evaluate the unfrozen looks; read today's live rule; WRITE the
    newly frozen looks; only then stamp `actionable` — ONCE, here. An Indeterminate anywhere freezes
    nothing, and the ledger is on disk before anything is printed, recorded or paged."""
    live_reader = read_live if live_reader is None else live_reader
    path = ledger_path() if ledger is None else ledger
    try:
        doc = load_ledger(path)
        decided, progress, fresh = evaluate_all(now, reader, pc, cps, index_guard=index_guard,
                                                frozen=doc["looks"], live_reader=live_reader)
        live = live_reader(now)
        if fresh:
            frozen_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            for look, family in fresh.items():
                doc["looks"][str(look)] = {"frozen_at": frozen_at, "source": f"evaluated by the run at now={_iso(now)}",
                                           "family": frozen_copy(family)}
            write_ledger(path, doc)
    except Indeterminate as exc:
        return INDET, [], [], str(exc)
    for r in decided:
        r["live"] = live[r["tf"]]
        r["actionable"] = is_actionable(r, r["live"])
    for r in progress:
        r["live"] = live[r["tf"]]
    return fold(decided), decided, progress, None


# ─────────────────────────────── the seed (CH1 R5) ─────────────────────────────────────────────

ISO_S = "%Y-%m-%dT%H:%M:%SZ"


def _iso_s(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime(ISO_S)


def _parse_at(s) -> int:
    return int(datetime.strptime(s, ISO_S).replace(tzinfo=timezone.utc).timestamp())


def seed_family(lines, now: int) -> tuple[dict[int, list[dict]], dict[int, int], dict]:
    """PURE: gate result lines -> ({look: family}, {look: earliest record epoch}, counts). Per (tf,
    window) the EARLIEST DECIDED record wins; `rec` and `cause` are copied, never recomputed. Every
    window the chain has decided by `now` must have both cell records at that instant — else
    Indeterminate. Absent `diag` and per-cell `days` stay null (printed `na`)."""
    groups: dict[tuple[str, int], dict[int, dict[str, dict]]] = {}
    counts = {"lines": 0, "gate": 0, "decided": 0}
    for i, ln in enumerate(lines, 1):
        if not ln.strip():
            continue
        counts["lines"] += 1
        try:
            d = json.loads(ln)
        except ValueError as exc:
            raise Indeterminate(f"line {i} is not JSON") from exc
        if not isinstance(d, dict) or d.get("canary") != DETECTOR:
            continue
        counts["gate"] += 1
        m = d.get("metrics")
        if not isinstance(m, dict):
            raise Indeterminate(f"line {i}: a gate record without metrics")
        if m.get("state") != "DECIDED":
            continue
        counts["decided"] += 1
        try:
            at, tf, k, cell = _parse_at(d["at"]), m["tf"], m["window"], m["cell"]
        except (KeyError, TypeError, ValueError) as exc:
            raise Indeterminate(f"line {i}: a DECIDED record without a parseable at/tf/window/cell") from exc
        if tf not in TIMEFRAMES or type(k) is not int or cell not in [f"{tf}|{r}" for r in REGIMES]:
            raise Indeterminate(f"line {i}: a DECIDED record names tf={tf!r} window={k!r} cell={cell!r}")
        slot = groups.setdefault((tf, k), {}).setdefault(at, {})
        regime = cell.split("|", 1)[1]
        if regime in slot and slot[regime] != m:
            raise Indeterminate(f"line {i}: two different {cell} records at {d['at']}")
        slot[regime] = m
    by_look: dict[int, list[dict]] = {}
    first_at: dict[int, int] = {}
    used = set()
    for tf in TIMEFRAMES:
        for w in window_chain(tf, T_START_EPOCH, now):
            if w["look"] > now:
                continue
            runs = groups.get((tf, w["k"]))
            if not runs:
                raise Indeterminate(f"chain window {tf} w{w['k']} (look {_iso(w['look'])}) lacks a cell record")
            at = min(runs)
            cells = runs[at]
            lacking = [r for r in REGIMES if r not in cells]
            if lacking:
                raise Indeterminate(f"chain window {tf} w{w['k']}: its earliest record ({_iso_s(at)}) lacks cell {lacking[0]}")
            up = cells[REGIMES[0]]
            for m in cells.values():
                if (m.get("look"), m.get("window_start"), m.get("window_end")) != (_iso(w["look"]), _day(w["start"]), _day(w["end"])):
                    raise Indeterminate(f"chain window {tf} w{w['k']}: the record's window or look differs from the registered chain")
                for key in ("rec", "cause", "incumbent", "clusters", "min_clusters", "rows", "scored", "alts"):
                    if m.get(key) != up.get(key):
                        raise Indeterminate(f"chain window {tf} w{w['k']}: its two cell records disagree on {key}")
            if up.get("rec") not in ("SWITCH_TO", "KEEP_INCUMBENT", INDET) or not isinstance(up.get("cause"), str) \
                    or not isinstance(up.get("alts"), dict):
                raise Indeterminate(f"chain window {tf} w{w['k']}: rec/cause/alts unparseable")
            by_look.setdefault(w["look"], []).append({
                "tf": tf, "k": w["k"], "start": w["start"], "end": w["end"], "look": w["look"], "state": "DECIDED",
                "rows": up.get("rows"), "scored": up.get("scored"), "alts": up["alts"],
                "diag": {a: {"ident": None} for a in DIAGNOSTIC},
                "cells": {r: {"m_edge": cells[r].get("m_edge"), "n": cells[r].get("n_decisive"), "days": None}
                          for r in REGIMES},
                "incumbent": up.get("incumbent"), "clusters": up.get("clusters"), "min_clusters": up.get("min_clusters"),
                "rec": up["rec"], "cause": up["cause"]})
            first_at[w["look"]] = min(first_at.get(w["look"], at), at)
            used.add((tf, w["k"]))
    counts["ignored"] = sum(len(c) for key, runs in groups.items() if key not in used for c in runs.values())
    return by_look, first_at, counts


def seed_ledger(lines, now: int, path: str, live_reader=None) -> tuple[str, list[str]]:
    """CH1 R5 — create the ledger ONCE. FAIL when one exists (untouched); INDETERMINATE, and no
    file, when a chain window lacks a cell record, a line is unparseable or the live read fails."""
    live_reader = read_live if live_reader is None else live_reader
    if os.path.lexists(path):
        return FAIL, [f"[{DETECTOR}] ledger already exists at {path} — untouched (the seed is create-only)"]
    try:
        by_look, first_at, counts = seed_family(lines, now)
        looks, report = {}, []
        for look in sorted(by_look):
            family = by_look[look]
            stamp_look(family, live_reader(look))
            family = frozen_copy(family)
            check_family(str(look), family)
            looks[str(look)] = {"frozen_at": _iso_s(first_at[look]),
                                "source": "seed: the earliest DECIDED gate record per window (vault canary-results.jsonl)",
                                "family": family}
            report.append(f"VERDICT_RULE_LEDGER_SEED look={_iso(look)} frozen_at={_iso_s(first_at[look])} family="
                          + ",".join(f"{r['tf']}:w{r['k']}:{r['rec']}:{r['cause']}:incumbent={r['incumbent']}"
                                     f":live_at_look={r['live_at_look']}:straddle={r['straddle']}" for r in family))
        report.append(f"VERDICT_RULE_LEDGER_SEED lines={counts['lines']} gate={counts['gate']} decided={counts['decided']}"
                      f" looks={len(looks)} windows={sum(len(v) for v in by_look.values())}"
                      f" ignored_records={counts['ignored']}")
        if not create_ledger(path, {"schema_version": LEDGER_SCHEMA, "looks": looks}):
            return FAIL, report + [f"[{DETECTOR}] ledger appeared at {path} during the seed — untouched"]
    except Indeterminate as exc:
        return INDET, [f"[{DETECTOR}] seed refused, no ledger written: {exc}"]
    except OSError as exc:
        return INDET, [f"[{DETECTOR}] seed could not write {path}: {type(exc).__name__}: {str(exc)[:80]}"]
    return PASS, report + [f"[{DETECTOR}] ledger created at {path}"]


def seed_main(argv: list[str], now: int) -> int:
    exit_for = {PASS: 0, FAIL: 1, INDET: 3}
    try:
        src = argv[argv.index("--records") + 1]
    except (ValueError, IndexError):
        print(f"[{DETECTOR}] usage: --seed-ledger --records <path|->")
        print(f"{SEED_TOKEN}={INDET}")
        return 3
    try:
        if src == "-":
            lines = sys.stdin.read().splitlines()
        else:
            with open(src, encoding="utf-8") as fh:
                lines = fh.read().splitlines()
    except (OSError, UnicodeDecodeError) as exc:
        print(f"[{DETECTOR}] records unreadable: {type(exc).__name__}")
        print(f"{SEED_TOKEN}={INDET}")
        return 3
    verdict, report = seed_ledger(lines, now, ledger_path())
    for ln in report:
        print(ln)
    print(f"{SEED_TOKEN}={verdict}")
    return exit_for[verdict]


# ─────────────────────────────── the run ───────────────────────────────────────────────────────

def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return _self_test()
    if "--show-config" in argv:
        print(json.dumps(show_config(), indent=1, sort_keys=True))
        return 0
    token = SEED_TOKEN if "--seed-ledger" in argv else TOKEN
    started = int(datetime.now(timezone.utc).timestamp())
    now = started
    if os.environ.get("VRG_NOW"):
        try:
            now = int(datetime.strptime(os.environ["VRG_NOW"].replace("Z", "+0000"),
                                        "%Y-%m-%dT%H:%M:%S%z").timestamp())
        except ValueError:
            print(f"[{DETECTOR}] VRG_NOW unparseable")
            print(f"{token}={INDET}")
            return 3
    if "--seed-ledger" in argv:
        return seed_main(argv, now)
    return run_gate(now, started)


def run_gate(now: int, started: int, ledger: str | None = None, wrapper: str | None = None,
             results_path: str | None = None) -> int:
    """One run: evaluate (the ledger written first), then print, record and page. The self-test
    drives THIS with the process seam replaced, so the printed, recorded and paged path is real."""
    run_id = f"{DETECTOR}-{datetime.fromtimestamp(started, timezone.utc):%Y%m%dT%H%M%SZ}"
    try:
        pc, cps, crl, de = load_libs()
    except Indeterminate as exc:
        print(f"[{DETECTOR}] could not evaluate: {exc}")
        print(f"{TOKEN}={INDET}")
        return 3
    verdict, decided, progress, why = evaluate_run(now, read_window, pc, cps, index_guard=require_hash_index,
                                                   ledger=ledger)
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
            ok, detail = crl.append_result(DETECTOR, verdict, exit_code, cell_record(res, regime), path=results_path)
            written += 1 if ok else 0
            if not ok:
                print(f"CANARY_RESULT_LOG_FAILED={detail}")
    print(f"CANARY_RESULT_LOG={results_path or crl.RESULTS_PATH} records={written}/{2 * len(shown)}")

    wrapper = wrapper or os.environ.get("VRG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
    if verdict == FAIL:
        _send(wrapper, [ALERT_ID, SEVERITY, "-"], page_body(decided), keys)
    elif verdict == PASS:
        # Clear only when something was genuinely evaluated and nothing is a switch away from the live
        # rule — a run that measured nothing clears nothing.
        _send(wrapper, ["--clear", ALERT_ID, CLEAR_REASON], None, None)
    print(f"{PAGE_KEYS_LINE}={','.join(keys) if keys else 'none'}")
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
    global _RUN, _REPLACE  # sections 11+ drive the real read path and the ledger through the seams
    failures: list[str] = []

    def check(label, cond):
        _CHECKS_RAN[0] += 1
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

    # 9. the ONE derivation (`actionable`), the straddle, the fold and the page keys
    def _stamped(res, live, strad="n"):
        r = {**res, "straddle": strad, "live": live}
        r["actionable"] = is_actionable(r, live)
        return r
    sw = _stamped(res_s, "MM")        # SWITCH_TO FF away from a live MM, window not straddled
    conf = _stamped(res_s, "FF")      # SWITCH_TO FF while FF is live: a confirmation
    keep = _stamped(res_null, "MM")
    check("actionable: a SWITCH_TO away from the live rule on an unstraddled window", sw["actionable"] is True)
    check("actionable: a SWITCH_TO the live rule is a confirmation, never actionable", conf["actionable"] is False)
    check("actionable: a straddled SWITCH_TO is never actionable", _stamped(res_s, "MM", "y")["actionable"] is False)
    check("actionable: an unknown live cell never suppresses a page (FF vs live F?)",
          _stamped(res_s, "F?", "?")["actionable"] is True)
    check("actionable: KEEP is never actionable", keep["actionable"] is False)
    check("straddle: y on a known differing cell, ? on an unknown one, n on a full match",
          straddle("MM", "FF") == "y" and straddle("MM", "MF") == "y" and straddle("MM", "F?") == "y"
          and straddle("FM", "F?") == "?" and straddle("MM", "??") == "?" and straddle("FF", "FF") == "n")
    check("fold: any actionable ⇒ FAIL", fold([sw, keep]) == FAIL)
    check("fold: a SWITCH_TO that is not actionable ⇒ PASS, never FAIL", fold([conf, keep]) == PASS and fold([conf]) == PASS)
    check("fold: evaluated, no switch ⇒ PASS", fold([keep]) == PASS)
    check("fold: nothing evaluated ⇒ INDETERMINATE", fold([]) == INDET and fold([g]) == INDET)
    check("page keys name the timeframe, the assignment and the window", page_keys([sw]) == ["15m:FF:w1"])
    check("page keys never include KEEP, INDETERMINATE or a confirmation", page_keys([keep, g, conf]) == [])

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
    rec = cell_record({**sw, "state": "DECIDED", "live_at_look": "MM"}, "TRENDING_DOWN")
    line = crl.build_record(DETECTOR, FAIL, 0, rec)
    check(f"one cell record, live fields included, fits the result log's line cap ({len(line)} B ≤ {crl.MAX_LINE_BYTES})",
          len(line.encode()) <= crl.MAX_LINE_BYTES)
    check("the record carries live, live_at_look, straddled and actionable",
          (rec["live"], rec["live_at_look"], rec["straddled"], rec["actionable"]) == ("MM", "MM", False, True)
          and cell_record({**sw, "state": "DECIDED", "straddle": "?"}, "TRENDING_UP")["straddled"] is None)
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
          "15m: switch MM -> FF" in page_body([{**sw, "state": "DECIDED"}]) and "never switches" in page_body([res_s]))
    check("the page body never lists a confirmation", "15m:" not in page_body([{**conf, "state": "DECIDED"}]))

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
    tmp = tempfile.mkdtemp(prefix="verdict-rule-gate-self-test.")
    empty_doc = {"schema_version": LEDGER_SCHEMA, "looks": {}}

    def _empty_ledger(name):
        p = os.path.join(tmp, name)
        create_ledger(p, empty_doc)
        return p

    def _live_lines(assign: dict) -> str:
        """What the live read returns for an assignment ({tf: 'FM'}, default MM, `?` = no row) — plus a
        1m row the parser must ignore."""
        out = []
        for tf in TIMEFRAMES:
            a = assign.get(tf, "MM")
            for i, regime in enumerate(REGIMES):
                if a[i] == UNKNOWN:
                    continue
                vm = "BUY" if regime == "TRENDING_UP" else "SELL"
                vf = "SELL" if vm == "BUY" else "BUY"
                out.append("|".join([tf, regime, vf if a[i] == "F" else vm, vm, vf]))
        out.append("1m|TRENDING_UP|SELL|BUY|SELL")
        return "\n".join(out) + "\n"

    def _fake(times_out):
        def run(cmd, **_kw):
            seen.append(cmd)
            sql = cmd[-1]
            if "pg_index" in sql:
                return subprocess.CompletedProcess(cmd, 0, "1\n", "")
            if "DISTINCT ON" in sql:
                return subprocess.CompletedProcess(cmd, 0, _live_lines({}), "")
            if not times_out(sql):
                return subprocess.CompletedProcess(cmd, 0, ok_rows if "LATERAL" in sql else "0|0\n", "")
            return subprocess.CompletedProcess(cmd, 1, "", "ERROR:  canceling statement due to statement timeout")
        return run

    real_run, real_replace = _RUN, _REPLACE
    try:
        _RUN = _fake(lambda sql: False)
        ctl = evaluate_run(look, read_window, pc, cps, index_guard=require_hash_index, ledger=_empty_ledger("ctl.json"))
        check("CONTROL: every read clean ⇒ the run is evaluated (PASS), so the fake is not what fails",
              lambda: ctl[0] == PASS and len(ctl[1]) == 4 and ctl[3] is None)
        _RUN = _fake(lambda sql: "'15m'" not in sql)
        to_ledger = _empty_ledger("timeout.json")
        out = evaluate_run(look, read_window, pc, cps, index_guard=require_hash_index, ledger=to_ledger)
        check("a statement timeout on ONE timeframe (15m read clean) ⇒ the whole RUN is INDETERMINATE, never PASS",
              lambda: out[0] == INDET and out[1] == [] and "statement timeout" in (out[3] or ""))
        check("…and an Indeterminate run freezes NOTHING (the ledger still has no look)",
              lambda: load_ledger(to_ledger)["looks"] == {})
        check("a timed-out statement raises (INDETERMINATE), never an empty result",
              _raises(lambda: psql("SELECT 1")))
        check("every statement — the live read included — ran read-only AND under the statement timeout",
              lambda: len(seen) > 4 and all(c[3] == f"PGOPTIONS={PGOPTIONS}" for c in seen)
              and any("DISTINCT ON" in c[-1] for c in seen)
              and f"-c statement_timeout={STATEMENT_TIMEOUT_MS}" in PGOPTIONS
              and "-c default_transaction_read_only=on" in PGOPTIONS)
        _self_test_live_rule(check, pc, cps, crl, tmp, _live_lines, null_rows, ok_rows)
    finally:
        _RUN, _REPLACE = real_run, real_replace

    total = len(failures)
    ran = _CHECKS_RAN[0]
    if ran < SELF_TEST_MIN_CHECKS:
        print(f"  FAIL VACUITY: {ran} check(s) ran, the floor is {SELF_TEST_MIN_CHECKS}")
        total += 1
    print(f"SELF-TEST: {'PASS' if total == 0 else f'FAIL ({total})'} ({ran} checks, floor {SELF_TEST_MIN_CHECKS})")
    print(f"{TOKEN}={PASS if total == 0 else INDET}")
    return 0 if total == 0 else 3


# The measured check count of the self-test, so removing a scenario trips it.
SELF_TEST_MIN_CHECKS = 122
_CHECKS_RAN = [0]


def _self_test_live_rule(check, pc, cps, crl, tmp, _live_lines, null_rows, ok_rows) -> None:
    """SIGNAL-VERDICT-RULE-GATE-LIVE-RULE-W1 CH1 R6: the live read, the straddle, the one `actionable`
    and the freeze — through `run_gate` / `evaluate_run`, the process seam and the REAL ledger
    functions in a temp dir. The live read always goes through `_RUN`; a frozen look's window reads
    and index probe are REFUSED by the seam, so reading one turns the run INDETERMINATE and the check red."""
    global _RUN, _REPLACE
    t3m = _parse_at("2026-10-31T11:29:08Z")     # the first F-served 3m row (prod, R0)
    t30 = _parse_at("2026-11-09T14:34:40Z")     # the first F-served 30m row (prod, R0)

    def live_1109(at):          # only 3m switched before 2026-11-09T12:43Z
        return {"3m": "FF"} if at > t3m else {}

    def live_after(at):         # 30m and 1h joined after that look
        return {**live_1109(at), **({"30m": "FF", "1h": "FF"} if at > t30 else {})}

    def _db(live_fn, window_rows=None):
        def run(cmd, **_kw):
            sql = cmd[-1]
            if "DISTINCT ON" in sql:
                at = int(re.search(r"decided_at < (\d+)", sql).group(1))
                return subprocess.CompletedProcess(cmd, 0, _live_lines(live_fn(at)), "")
            if window_rows is None:
                return subprocess.CompletedProcess(cmd, 1, "", "ERROR:  self-test: a frozen look was read")
            if "pg_index" in sql:
                return subprocess.CompletedProcess(cmd, 0, "1\n", "")
            if "LATERAL" in sql:
                return subprocess.CompletedProcess(cmd, 0, window_rows(re.search(r"ssi.timeframe = '([^']+)'", sql).group(1)), "")
            return subprocess.CompletedProcess(cmd, 0, "0|0\n", "")
        return run

    def member(tf, w, rec="KEEP_INCUMBENT", cause="no_admissible_improvement", inc="MM"):
        alts = {a: {"ident": 50.0} for a in S1 if a != inc}
        if rec == "SWITCH_TO":
            alts[cause] = {"ident": 50.0, "delta": 0.05, "p": 0.001, "mag": 1.5, "mag_pos": 0.6,
                           "admissible": True, "switched": 2, "holm": True, "veto": False}
        return {"tf": tf, "k": w["k"], "start": w["start"], "end": w["end"], "look": w["look"], "state": "DECIDED",
                "rows": 1000, "scored": 1000, "alts": alts, "diag": {"MF": {"ident": 0.1}},
                "cells": {r: {"m_edge": 0.01, "n": 100, "days": 14} for r in REGIMES},
                "incumbent": inc, "clusters": 14, "min_clusters": TIMEFRAMES[tf][3], "rec": rec, "cause": cause}

    def families(now, plan):
        """Every look the chain has decided by `now`: KEEP/MM unless plan[(tf, k)] = (rec, cause, incumbent)."""
        by_look = {}
        for tf in TIMEFRAMES:
            for w in window_chain(tf, T_START_EPOCH, now):
                if w["look"] <= now:
                    by_look.setdefault(w["look"], []).append(member(tf, w, *plan.get((tf, w["k"]), ())))
        return by_look

    def ledger_doc(now, plan, live_fn):
        looks = {}
        for look, fam in families(now, plan).items():
            stamp_look(fam, parse_live([ln.split("|") for ln in _live_lines(live_fn(look)).splitlines()]))
            looks[str(look)] = {"frozen_at": _iso_s(look), "source": "self-test", "family": frozen_copy(fam)}
        return {"schema_version": LEDGER_SCHEMA, "looks": looks}

    stub_src = ('#!/bin/sh\n{ printf "ARGS=%s\\n" "$*"; printf "KEYS=%s\\n" "${ALERT_KEYS:-}"; } >> "$0.calls"\n'
                'if [ "$3" = "-" ]; then cat >> "$0.body"; fi\n')

    def _read(p):
        try:
            with open(p, encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            return ""

    def safe(fn):
        """Run fn; an exception becomes a value, so a broken path turns checks red instead of crashing
        the self-test before it prints its token."""
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            return ("RAISED", f"{type(exc).__name__}: {exc}")

    def scenario(name, now, plan, live_fn, ledger_doc_=None, window_rows=None):
        return safe(lambda: _scenario(name, now, plan, live_fn, ledger_doc_, window_rows))

    def _scenario(name, now, plan, live_fn, ledger_doc_=None, window_rows=None):
        """One real run (run_gate): its own ledger, results log and stub wrapper in a temp dir."""
        global _RUN
        d = os.path.join(tmp, name)
        os.makedirs(d)
        led, stub, results = os.path.join(d, "ledger.json"), os.path.join(d, "wrapper.sh"), os.path.join(d, "results.jsonl")
        doc = ledger_doc(now, plan, live_fn) if ledger_doc_ is None else ledger_doc_
        if doc != "absent":
            if isinstance(doc, str):
                with open(led, "w", encoding="utf-8") as fh:
                    fh.write(doc)
            else:
                create_ledger(led, doc)
        before = _read(led)
        with open(stub, "w", encoding="utf-8") as fh:
            fh.write(stub_src)
        os.chmod(stub, 0o755)
        _RUN = _db(live_fn, window_rows)
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = run_gate(now, now, ledger=led, wrapper=stub, results_path=results)
        out = buf.getvalue().splitlines()
        return {"rc": rc, "out": out, "calls": _read(stub + ".calls"), "body": _read(stub + ".body"),
                "records": [json.loads(x) for x in _read(results).splitlines() if x.strip()],
                "ledger_unchanged": _read(led) == before, "dir": d, "ledger": led}

    def line(s, tf, k):
        return next((x for x in s["out"] if x.startswith(f"VERDICT_RULE_GATE tf={tf} window={k} ")), "")

    def rec_of(s, tf, regime="TRENDING_DOWN"):
        return next((r["metrics"] for r in s["records"] if r["metrics"]["cell"] == f"{tf}|{regime}"), {})

    # 12. the live read's bypassed artifacts — the SQL, the binder, the parser, the shared predicate
    check("the live read is the latest trend-decisive served row per cell, outcome-free",
          "DISTINCT ON (ssi.timeframe, ssi.regime)" in LIVE_SQL
          and "ORDER BY ssi.timeframe, ssi.regime, ssi.decided_at DESC, ssi.scorer_input_id DESC;" in LIVE_SQL
          and "ssi.trend_decisive" in LIVE_SQL and "outcome_return_pct" not in LIVE_SQL and "JOIN" not in LIVE_SQL)
    check("the live read excludes BITMART and unstamped rows and never touches a withheld arm",
          "ssi.exchange <> 'BITMART'" in LIVE_SQL and "ssi.rule_config_id IS NOT NULL" in LIVE_SQL
          and not any(t in LIVE_SQL for t in ("hold", "band")))
    lb = render_live(LIVE_SQL, 100, 200)
    check("the live binder fills both bounds and leaves no placeholder",
          "ssi.decided_at >= 100 AND ssi.decided_at < 200" in lb and ":since" not in lb and ":at" not in lb)
    check("the live binder refuses non-integer or empty bounds",
          all(_raises(lambda a=a: render_live(LIVE_SQL, *a)) for a in ((1.5, 2), ("1", 2), (True, 2), (5, 5), (6, 5))))
    check("the live read looks back 14 days", LIVE_LOOKBACK_DAYS == 14)
    pl = parse_live([["3m", "TRENDING_UP", "SELL", "BUY", "SELL"], ["3m", "TRENDING_DOWN", "BUY", "SELL", "BUY"],
                     ["30m", "TRENDING_UP", "BUY", "BUY", "SELL"], ["1m", "TRENDING_UP", "SELL", "BUY", "SELL"]])
    check("the live parser: F/M per cell, `?` for a cell with no row, every registered timeframe",
          pl["3m"] == "FF" and pl["30m"] == "M?" and pl["15m"] == "??" and sorted(pl) == sorted(TIMEFRAMES))
    check("a timeframe outside the registry (1m) is ignored, never Indeterminate", "1m" not in pl)
    check("a live row with a bad field count, regime or side, or a duplicate cell, is INDETERMINATE",
          _raises(lambda: parse_live([["3m", "TRENDING_UP", "SELL"]]))
          and _raises(lambda: parse_live([["3m", "RANGING", "BUY", "BUY", "SELL"]]))
          and _raises(lambda: parse_live([["3m", "TRENDING_UP", "HOLD", "BUY", "SELL"]]))
          and _raises(lambda: parse_live([["3m", "TRENDING_UP", "BUY", "BUY", "SELL"]] * 2)))
    check("incumbent() and read_live() share ONE predicate (served = fade ≠ trend ⇒ F)",
          served_rule("SELL", "BUY", "SELL") == "F" and served_rule("BUY", "BUY", "SELL") == "M"
          and served_rule("BUY", "BUY", "BUY") == "M"
          and incumbent([{"decisive": True, "regime": "TRENDING_UP", "served": "SELL", "verdict_m": "BUY",
                          "verdict_f": "SELL", "decided_at": 1}]) == "FM")

    # 13. 2026-11-09 — only 3m live on F: 3m reads as live; the keys are exactly 1h:FF:w2 and 30m:FF:w2
    plan_1109 = {("3m", 1): ("SWITCH_TO", "FF", "MM"), ("30m", 2): ("SWITCH_TO", "FF", "MM"),
                 ("1h", 2): ("SWITCH_TO", "FF", "MM")}
    now_1109 = _parse_at("2026-11-09T12:43:14Z")
    s = scenario("s1109", now_1109, plan_1109, live_1109)
    check("2026-11-09: FAIL, exit 0, and the page-keys line names exactly 1h:FF:w2,30m:FF:w2",
          lambda: s["rc"] == 0 and s["out"][-1] == f"{TOKEN}={FAIL}"
          and s["out"][-2] == f"{PAGE_KEYS_LINE}=1h:FF:w2,30m:FF:w2")
    check("2026-11-09: 3m prints live=FF … page=n (a switch already made is not re-listed)",
          lambda: " incumbent=MM live=FF live_at_look=MM straddle=n page=n " in line(s, "3m", 1))
    check("2026-11-09: 30m and 1h print live=MM … page=y",
          lambda: all(" live=MM live_at_look=MM straddle=n page=y " in line(s, tf, 2) for tf in ("30m", "1h")))
    check("2026-11-09: the wrapper got the page with ALERT_KEYS exactly the two actionable keys",
          lambda: f"ARGS={ALERT_ID} {SEVERITY} -" in s["calls"] and "KEYS=1h:FF:w2 30m:FF:w2" in s["calls"])
    check("2026-11-09: the body names 30m and 1h and NOT 3m",
          lambda: "30m: switch MM -> FF" in s["body"] and "1h: switch MM -> FF" in s["body"] and "3m:" not in s["body"])
    check("2026-11-09: no frozen look was read and the ledger is untouched", lambda: s["ledger_unchanged"])
    check("2026-11-09: the records carry the live fields (3m live FF, not actionable; 30m actionable)",
          lambda: (rec_of(s, "3m")["live"], rec_of(s, "3m")["actionable"], rec_of(s, "30m")["actionable"],
                   rec_of(s, "30m")["straddled"]) == ("FF", False, True, False) and len(s["records"]) == 20)

    # 14. after the switch: all three live on F — no keys, PASS, the clear path
    s = scenario("after", _parse_at("2026-11-10T03:00:00Z"), plan_1109, live_after)
    check("after the switch: PASS, keys none, and the wrapper is CLEARED with the live-rule reason",
          lambda: s["out"][-1] == f"{TOKEN}={PASS}" and s["out"][-2] == f"{PAGE_KEYS_LINE}=none"
          and s["calls"].strip().splitlines()[0] == f"ARGS=--clear {ALERT_ID} {CLEAR_REASON}" and s["body"] == "")
    check("after the switch: 30m prints live=FF live_at_look=MM straddle=n page=n; progress prints straddle=na",
          lambda: " live=FF live_at_look=MM straddle=n page=n " in line(s, "30m", 2)
          and " live=FF straddle=na " in line(s, "30m", 3))

    # 15. the straddle: incumbent MM, FF live at the look — SWITCH_TO FF, SWITCH_TO FM, KEEP: no key, PASS
    now_1123 = _parse_at("2026-11-23T12:43:14Z")
    for i, (rec, cause) in enumerate((("SWITCH_TO", "FF"), ("SWITCH_TO", "FM"), ("KEEP_INCUMBENT", "no_admissible_improvement"))):
        s = scenario(f"straddle{i}", now_1123, {("3m", 2): (rec, cause, "MM")}, live_after)
        check(f"straddle: 3m w2 {rec} {cause} ⇒ straddle=y, no key, PASS",
              lambda s=s: " incumbent=MM live=FF live_at_look=FF straddle=y page=n " in line(s, "3m", 2)
              and s["out"][-2] == f"{PAGE_KEYS_LINE}=none" and s["out"][-1] == f"{TOKEN}={PASS}"
              and rec_of(s, "3m")["straddled"] is True)

    # 16. clean and unknown
    w3 = window_chain("30m", T_START_EPOCH, T_START_EPOCH + 400 * DAY_S)[2]
    s = scenario("clean", w3["look"] + 14, {("30m", 3): ("SWITCH_TO", "MM", "FF")}, lambda at: {"30m": "FF"})
    check("clean: incumbent and live FF, SWITCH_TO MM ⇒ the key 30m:MM:w3, FAIL",
          lambda: s["out"][-2] == f"{PAGE_KEYS_LINE}=30m:MM:w3" and s["out"][-1] == f"{TOKEN}={FAIL}"
          and " incumbent=FF live=FF live_at_look=FF straddle=n page=y " in line(s, "30m", 3))
    s = scenario("unknown", w3["look"] + 14, {("30m", 3): ("SWITCH_TO", "FF", "FM")}, lambda at: {"30m": "F?"})
    check("unknown: live F? ⇒ SWITCH_TO FF still pages, straddle=? (unknown never suppresses)",
          lambda: s["out"][-2] == f"{PAGE_KEYS_LINE}=30m:FF:w3" and "KEYS=30m:FF:w3" in s["calls"]
          and " incumbent=FM live=F? live_at_look=F? straddle=? page=y " in line(s, "30m", 3)
          and rec_of(s, "30m")["straddled"] is None)

    # 17. the freeze — evaluated once, then never read, guarded or re-evaluated
    w15 = window_chain("15m", T_START_EPOCH, T_START_EPOCH + 400 * DAY_S)[0]
    now_f = w15["look"] + 14
    led_f = os.path.join(tmp, "freeze.json")
    create_ledger(led_f, {"schema_version": LEDGER_SCHEMA, "looks": {}})
    guard_calls = {"n": 0}

    def guard_ok():
        guard_calls["n"] += 1

    def boom(*_a):
        raise AssertionError("a frozen look was read or guarded")

    _RUN = _db(live_1109)
    reader_1 = lambda tf, w_: (null_rows if tf == "15m" else [], (0, 0))  # noqa: E731
    r1 = safe(lambda: evaluate_run(now_f, reader_1, pc, cps, index_guard=guard_ok, ledger=led_f))
    recs = lambda r: [cell_record(x, g) for x in r[1] for g in REGIMES]  # noqa: E731
    stored = safe(lambda: load_ledger(led_f)["looks"])
    check("freeze: the first run evaluates the look once (guard once) and writes its WHOLE family",
          lambda: r1[0] == PASS and guard_calls["n"] == 1 and list(stored) == [str(w15["look"])]
          and sorted(m["tf"] for m in stored[str(w15["look"])]["family"]) == sorted(["15m", "30m", "1h", "2h"]))
    check("freeze: the ledger stores no per-run field (live, actionable)",
          lambda: not any(f in m for m in stored[str(w15["look"])]["family"] for f in PER_RUN_FIELDS))
    r2 = safe(lambda: evaluate_run(now_f, boom, pc, cps, index_guard=boom, ledger=led_f))
    check("freeze: a second run returns the IDENTICAL records — reader and guard raise if called",
          lambda: r2[0] == r1[0] and recs(r2) == recs(r1))
    _RUN = _db(lambda at: {"15m": "FF"})
    r3 = safe(lambda: evaluate_run(now_f + DAY_S, boom, pc, cps, index_guard=boom, ledger=led_f))
    check("freeze: a later run with another live rule changes ONLY live/actionable, never the frozen fields",
          lambda: [{k: v for k, v in x.items() if k not in ("live", "actionable")} for x in recs(r3)]
          == [{k: v for k, v in x.items() if k not in ("live", "actionable")} for x in recs(r1)]
          and all(x["live"] == "FF" for x in recs(r3) if x["tf"] == "15m"))

    # 18. the ledger — absent, corrupt, wrong schema, a stored per-run field, unwritable: INDETERMINATE, no page
    # Every case below has READABLE windows behind it (15m rows; the rest empty), so a broken ledger
    # read as an empty ledger would evaluate and PASS — only the refusal yields INDETERMINATE.
    rows_text = "\n".join("|".join([str(r["id"]), r["regime"], "t" if r["decisive"] else "f", r["verdict_m"],
                                    r["verdict_f"], r["served"], str(r["decided_at"]), repr(r["r"])])
                          for r in null_rows) + "\n"
    rows_fn = lambda tf: rows_text if tf == "15m" else ""  # noqa: E731
    perrun = ledger_doc(now_f, {}, live_1109)
    next(iter(perrun["looks"].values()))["family"][0]["live"] = "FF"
    _RUN = _db(live_1109, rows_fn)
    ctl_f = scenario("ledger-control", now_f, {}, live_1109, ledger_doc_={"schema_version": 1, "looks": {}},
                     window_rows=rows_fn)
    check("ledger CONTROL: an empty-but-valid ledger with readable windows evaluates (PASS) — the fake is not what fails",
          lambda: ctl_f["rc"] == 0 and ctl_f["out"][-1] == f"{TOKEN}={PASS}")
    for name, doc in (("absent", "absent"), ("corrupt", "{not json"),
                      ("schema", {"schema_version": 2, "looks": {}}), ("perrun", perrun)):
        s = scenario(f"ledger-{name}", now_f, {}, live_1109, ledger_doc_=doc, window_rows=rows_fn)
        check(f"ledger {name}: INDETERMINATE exit 3, no page-keys line, the wrapper never called",
              lambda s=s: s["rc"] == 3 and s["out"][-1] == f"{TOKEN}={INDET}" and s["calls"] == ""
              and not any(x.startswith(PAGE_KEYS_LINE) for x in s["out"]))
    _RUN = _db(live_1109)
    absent = safe(lambda: evaluate_run(now_f, reader_1, pc, cps, ledger=os.path.join(tmp, "never-seeded.json")))
    check("ledger absent: evaluate_run says so (never an empty ledger)",
          lambda: absent[0] == INDET and "ledger absent" in absent[3])

    def failing_replace(src, dst):
        raise OSError(30, "Read-only file system")

    _REPLACE = failing_replace
    try:
        s = scenario("ledger-unwritable", now_f, {}, live_1109, ledger_doc_={"schema_version": 1, "looks": {}},
                     window_rows=lambda tf: rows_text if tf == "15m" else "")
    finally:
        _REPLACE = os.replace
    check("ledger unwritable (the rename fails): INDETERMINATE, no page, the old ledger byte-identical, no temp left",
          lambda: s["rc"] == 3 and s["calls"] == "" and s["ledger_unchanged"]
          and sorted(os.listdir(s["dir"])) == ["ledger.json", "wrapper.sh"])

    # 19. the seed — earliest record wins, rec/cause copied, a missing window or a bad line refuses, create-only
    now_s = _parse_at("2026-11-10T03:00:00Z")
    lines = ["{\"canary\":\"other\",\"at\":\"2026-11-01T00:00:00Z\",\"metrics\":{}}"]
    plan_s = {("5m", 1): ("SWITCH_TO", "FM", "MM")}
    for look, fam in families(now_s, plan_s).items():
        for m in fam:
            if m["tf"] == "5m":
                m["alts"]["FM"]["p"] = 0.9         # a SWITCH_TO that would NOT survive a recompute
            for g in REGIMES:
                lines.append(crl.build_record(DETECTOR, PASS, 0, cell_record(m, g), at=_iso_s(look + 9)))
            if (m["tf"], m["k"]) == ("15m", 1):    # a LATER re-read of 15m w1 that says something else
                later = {**m, "rec": "SWITCH_TO", "cause": "FM"}
                later["alts"] = {**m["alts"], "FM": {"ident": 50.0, "delta": 0.1, "p": 0.0001, "mag": 1.0,
                                                     "mag_pos": 0.9, "admissible": True, "switched": 1,
                                                     "holm": True, "veto": False}}
                for g in REGIMES:
                    lines.append(crl.build_record(DETECTOR, FAIL, 0, cell_record(later, g), at=_iso_s(look + 7 * DAY_S)))
    _RUN = _db(live_after)
    seed_p = os.path.join(tmp, "seed.json")
    v, rep = safe(lambda: seed_ledger(lines, now_s, seed_p))
    seeded = safe(lambda: load_ledger(seed_p)["looks"]) if os.path.exists(seed_p) else {}
    seeded = seeded if isinstance(seeded, dict) else {}
    by = {(m["tf"], m["k"]): m for e in seeded.values() for m in e["family"]}
    check("seed: PASS with every look the chain decided (10-19, 10-26, 11-02, 11-09)",
          lambda: v == PASS and sorted(_iso(int(k))[:10] for k in seeded)
          == ["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"])
    check("seed: the EARLIEST record per window wins (15m w1 stays KEEP)", lambda: by[("15m", 1)]["rec"] == "KEEP_INCUMBENT")
    check("seed: rec and cause are COPIED, never recomputed (5m w1 SWITCH_TO FM at p 0.9)",
          lambda: (by[("5m", 1)]["rec"], by[("5m", 1)]["cause"]) == ("SWITCH_TO", "FM"))
    check("seed: live_at_look is the live read AT THE LOOK, not now (30m w2: MM at 11-09 though FF now)",
          lambda: by[("30m", 2)]["live_at_look"] == "MM" and live_after(now_s)["30m"] == "FF"
          and by[("3m", 1)]["live_at_look"] == "MM" and by[("30m", 2)]["straddle"] == "n")
    check("seed: absent diag and per-cell days print `na`",
          lambda: "diag=MF:ident=na/3.0" in tf_line({**by[("15m", 1)], "live": "MM"})
          and " days=na/12 " in cell_lines(by[("15m", 1)])[0])
    s = scenario("seeded-run", now_s, {}, live_after, ledger_doc_={"schema_version": LEDGER_SCHEMA, "looks": seeded} if seeded else "absent")
    check("seed: the gate runs on the seeded ledger without reading a window (all looks frozen)",
          lambda: s["rc"] == 0 and s["out"][-1] in (f"{TOKEN}={PASS}", f"{TOKEN}={FAIL}") and s["ledger_unchanged"])
    miss = [ln for ln in lines if not ('"cell":"4h|TRENDING_DOWN"' in ln and '"window":1' in ln)]
    miss_p = os.path.join(tmp, "seed-miss.json")
    v2, rep2 = safe(lambda: seed_ledger(miss, now_s, miss_p))
    check("seed: a chain window lacking a cell record ⇒ INDETERMINATE, no file",
          lambda: v2 == INDET and not os.path.exists(miss_p) and "lacks" in rep2[0])
    bad_p = os.path.join(tmp, "seed-bad.json")
    v3, _ = safe(lambda: seed_ledger(lines + ["{oops"], now_s, bad_p))
    check("seed: an unparseable line ⇒ INDETERMINATE, no file", lambda: v3 == INDET and not os.path.exists(bad_p))
    before = _read(seed_p)
    v4, _ = safe(lambda: seed_ledger(lines, now_s, seed_p))
    check("seed: an existing ledger ⇒ FAIL, untouched (create-only)", lambda: v4 == FAIL and _read(seed_p) == before)


def _raises(fn) -> bool:
    try:
        fn()
    except Indeterminate:
        return True
    return False


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

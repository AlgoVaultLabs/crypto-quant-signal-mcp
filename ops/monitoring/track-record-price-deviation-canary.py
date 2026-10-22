#!/usr/bin/env python3
"""
track-record-price-deviation-canary.py — OPS-SERVED-CANDLE-TRUTH-W1 CH2.

The OUTPUT-side guard for the serving-window defect class. CH1 refuses a stale candle window at the getAdapter
seam and the contiguity canary's S leg reads every serving window; both watch the INPUT. This watches what the
input produced: the price each call was recorded at, `signals.price_at_signal` — the last close of the window the
call was computed on, i.e. the forming bar, so a LIVE price on every timeframe.

WHY. BITGET 1d calls were priced from a candle window that ended about ten days before the call, and nothing read
the recorded price. A call priced from a window that ended days ago sits away from the same coin on every other
venue at the same hour; a call priced from a live window does not.

METRIC, per (venue, timeframe), over the trailing WINDOW_S (24 h) of `signals`:
  dev(row)  = |price_at_signal - ref| / ref
  ref       = the median, over every OTHER venue that recorded the same coin in the same UTC-hour bucket
              (BUCKET_S), of that venue's median price_at_signal in the bucket. The row's own venue is excluded,
              so a venue serving stale data cannot vouch for itself.
  pair      = the median dev over its rows that have a reference; judged once n >= N_MIN.
  fleet F   = the median of the judged pair medians.
  FAIL      iff pair median > max(FLOOR, K x F). K x F keeps a market-wide move (every venue apart from every other
              in a volatile hour) from reading as one venue's defect; FLOOR keeps a calm day's tiny F from turning
              ordinary cross-venue noise into a FAIL.

PAGE. `track_record_price_deviation` (CRITICAL_PERSISTENT) once one pair FAILs on STREAK (2) consecutive runs. A
run in which a pair is not judged (n < N_MIN, or no rows) neither advances nor resets its streak; a judged PASS
resets it. A run that leaves no pair at the paging streak calls --clear (silent; the registry row decides any
announcement). Severity gate, 24 h cooldown, DRY_RUN_TG / ALGOVAULT_TG_TEST_INERT and the W{NEXT} template all live
in send_telegram.sh — this file owns only the query, the judgement and the streaks.

CALIBRATION. The constants below are a gate's decision inputs, so they are baked here, never fetched. Measured
2026-10-22 over 30 days of `signals` (2026-09-22T15:12:13Z..2026-10-22T15:12:13Z, 336,134 rows, read-only), with
the instrument this file ships (`build_sql`; re-run it any time with `--replay 30`): 238,336 rows (70.9 %) had a
same-coin reference in their hour. Positive control, BITGET 1d (the defect itself, every row pre-fix): judged on
11 of 30 daily runs, FAIL on 10, paged on 2026-10-02 (its second consecutive FAIL). Every other pair, simulated at
every even run hour: 0 pages in 30 days; a single-run FAIL on at most 3 of 30 runs, and on 0 of 30 at 06-12Z —
hence the 08:29 schedule. The full table lives in the vault (status.md, OPS-SERVED-CANDLE-TRUTH-W1 CH2).
What it can NOT see: a defect whose median deviation stays under FLOOR — a window stale by hours, or by one daily
bar on a calm coin. CH1's seam guard (HEAD_STALE_BARS) owns that band; this canary owns days.

RECORD. One line per run via canary_result_log.append_result -> canary-results.jsonl; monitoring-results-sync.sh
pulls it into the vault.

VERDICT. Exactly one terminal TRACK_RECORD_PRICE_DEVIATION_VERDICT=PASS|FAIL|INDETERMINATE (exit 0 / 0 / 3; FAIL
exits 0 because the page is the action). INDETERMINATE = the query failed, its output did not parse, or fewer than
MIN_JUDGED_PAIRS pairs were judged — a fleet median over a handful of pairs verifies nothing, and "verified nothing"
is never a PASS. An INDETERMINATE run moves no streak and sends nothing.

Install (host): /opt/algovault-monitoring/track-record-price-deviation-canary.py  (SoT: repo ops/monitoring/)
Cron (daily, off-:00): 29 8 * * *

    track-record-price-deviation-canary.py --self-test        # hermetic: no DB, no wrapper, no state, no record
    track-record-price-deviation-canary.py --replay 30 [--at 08:29]
                                                               # read-only: judge each of the last N days as the
                                                               # cron would have, streaks included; sends nothing

Env:
  TG_WRAPPER                          default /opt/algovault-monitoring/send_telegram.sh
  TRACK_RECORD_PRICE_DEVIATION_STATE  default /var/lib/algovault-monitoring/track-record-price-deviation-state.json
"""
from __future__ import annotations

import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple

CANARY = "track-record-price-deviation"
TAG = "[track-record-price-deviation]"
VERDICT_TOKEN = "TRACK_RECORD_PRICE_DEVIATION_VERDICT"
EXIT_INDETERMINATE = 3
SEVERITY = "CRITICAL_PERSISTENT"
RECOMMENDED_WAVE = "OPS-SERVED-CANDLE-TRUTH-W{NEXT}"

PG_CONTAINER = "crypto-quant-signal-mcp-postgres-1"
PG_DB = "signal_performance"
# Read-only at the session level: a write this canary never issues would be refused by the server, not by review.
PG_OPTIONS = "-c default_transaction_read_only=on -c statement_timeout=120000"
WRAPPER = os.environ.get("TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
STATE_PATH = os.environ.get(
    "TRACK_RECORD_PRICE_DEVIATION_STATE",
    "/var/lib/algovault-monitoring/track-record-price-deviation-state.json",
)

# ── calibrated decision inputs (see CALIBRATION above) ───────────────────────────────────────────────────────────
WINDOW_S = 86_400       # the trailing window each run judges
BUCKET_S = 3_600        # the same-coin reference bucket: one UTC hour
N_MIN = 3               # rows with a reference before a pair is judged
K = 10                  # a pair FAILs above K x the fleet median ...
FLOOR = 0.04            # ... and above this absolute floor (4 %)
STREAK = 2              # consecutive FAIL runs of one pair before a page
MIN_JUDGED_PAIRS = 20   # fewer judged pairs than this: the fleet median means nothing -> INDETERMINATE
BODY_MAX_PAIRS = 10     # a Telegram message is bounded; the result record carries the full failing set
WORST_COINS = 3


class QueryError(Exception):
    """A query we were HANDED and could not run. INDETERMINATE, never a pass."""


class ParseError(Exception):
    """Output we were handed and could not parse. INDETERMINATE, never a pass."""


class Row(NamedTuple):
    venue: str
    tf: str
    t: int
    nref: int
    dev: float | None     # signed (price - ref) / ref; None when no other venue had the coin in that hour
    coin: str


def log(msg: str) -> None:
    print(f"{TAG} {msg}", flush=True)


def _int(v, name: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"{name} must be an int, got {type(v).__name__}")
    return v


def build_sql(lo: int, hi: int, bucket_s: int = BUCKET_S) -> str:
    """PURE. The one instrument: the live run, --replay and the calibration all read through this string.

    Integer literals only, validated, so nothing caller-shaped ever reaches the query text. LEFT JOIN, so a row with
    no reference still comes back (nref 0) and is counted in the pair's `rows` — the predicate's exclusions are
    printed, never silently dropped. `created_at` is INTEGER epoch seconds, so `t / bucket` is integer division.
    """
    lo, hi, bucket_s = _int(lo, "lo"), _int(hi, "hi"), _int(bucket_s, "bucket_s")
    if not (0 < lo < hi) or bucket_s <= 0:
        raise ValueError(f"bad window lo={lo} hi={hi} bucket_s={bucket_s}")
    return (
        "WITH s AS ("
        " SELECT id, coin, coalesce(exchange, 'HL') AS ex, timeframe AS tf, created_at AS t, price_at_signal AS p"
        f" FROM signals WHERE created_at >= {lo} AND created_at < {hi} AND price_at_signal > 0"
        "), b AS ("
        f" SELECT coin, ex, t / {bucket_s} AS bk, percentile_cont(0.5) WITHIN GROUP (ORDER BY p) AS vp"
        f" FROM s GROUP BY coin, ex, t / {bucket_s}"
        "), r AS ("
        " SELECT a.id, a.ex, a.tf, a.coin, a.t, a.p, count(b.vp) AS nref,"
        " percentile_cont(0.5) WITHIN GROUP (ORDER BY b.vp) AS ref"
        f" FROM s a LEFT JOIN b ON b.coin = a.coin AND b.bk = a.t / {bucket_s} AND b.ex <> a.ex"
        " GROUP BY a.id, a.ex, a.tf, a.coin, a.t, a.p"
        ") SELECT ex, tf, t, nref, CASE WHEN nref > 0 THEN round(((p - ref) / ref)::numeric, 6) END, coin FROM r"
    )


def build_excluded_sql(lo: int, hi: int) -> str:
    """PURE. The rows build_sql's `price_at_signal > 0` predicate leaves out, beside the corpus size."""
    lo, hi = _int(lo, "lo"), _int(hi, "hi")
    if not (0 < lo < hi):
        raise ValueError(f"bad window lo={lo} hi={hi}")
    return ("SELECT count(*), count(*) FILTER (WHERE NOT (price_at_signal > 0))"
            f" FROM signals WHERE created_at >= {lo} AND created_at < {hi}")


def parse_rows(raw: str) -> list[Row]:
    """PURE. `ex|tf|t|nref|dev|coin`, coin LAST and split with maxsplit, so a coin carrying the separator still
    parses. Anything else raises ParseError: output we could not read is INDETERMINATE, never an empty fleet."""
    rows: list[Row] = []
    for n, line in enumerate(raw.split("\n"), 1):
        if not line.strip():
            continue
        parts = line.split("|", 5)
        if len(parts) != 6 or not parts[0] or not parts[1] or not parts[5]:
            raise ParseError(f"line {n}: expected 6 fields, got {len(parts)}: {line[:80]!r}")
        try:
            t, nref = int(parts[2]), int(parts[3])
            dev = float(parts[4]) if parts[4] != "" else None
        except ValueError as e:
            raise ParseError(f"line {n}: {e}: {line[:80]!r}") from None
        if (dev is None) != (nref == 0):
            raise ParseError(f"line {n}: nref={nref} with dev={parts[4]!r}")
        rows.append(Row(parts[0], parts[1], t, nref, dev, parts[5]))
    return rows


def parse_excluded(raw: str) -> tuple[int, int]:
    parts = raw.strip().split("|")
    if len(parts) != 2:
        raise ParseError(f"excluded count: expected 2 fields, got {raw[:80]!r}")
    try:
        return int(parts[0]), int(parts[1])
    except ValueError as e:
        raise ParseError(f"excluded count: {e}") from None


def pair_key(venue: str, tf: str) -> str:
    return f"{venue}|{tf}"


def judge(rows: list[Row], n_min: int = N_MIN, k: float = K, floor: float = FLOOR,
          min_judged: int = MIN_JUDGED_PAIRS) -> dict:
    """PURE. Judge every (venue, timeframe) pair seen in `rows`.

    Returns {verdict, reason, fleet, threshold, judged, pairs: {key: {venue, tf, rows, n, median, verdict, worst}}}.
    A pair below n_min is INSUFFICIENT — reported, never judged.
    """
    acc: dict[str, dict] = {}
    for r in rows:
        p = acc.setdefault(pair_key(r.venue, r.tf), {"venue": r.venue, "tf": r.tf, "rows": 0, "devs": []})
        p["rows"] += 1
        if r.dev is not None:
            p["devs"].append((abs(r.dev), r.coin))
    pairs: dict[str, dict] = {}
    for key, p in acc.items():
        devs = [d for d, _ in p["devs"]]
        pairs[key] = {"venue": p["venue"], "tf": p["tf"], "rows": p["rows"], "n": len(devs),
                      "median": statistics.median(devs) if devs else None,
                      "worst": [(c, d) for d, c in sorted(p["devs"], reverse=True)[:WORST_COINS]],
                      "verdict": "INSUFFICIENT"}
    judged = [v for v in pairs.values() if v["n"] >= n_min]
    out = {"pairs": pairs, "judged": len(judged), "fleet": None, "threshold": None}
    if not rows:
        return {**out, "verdict": "INDETERMINATE", "reason": "no signals rows in the window"}
    if len(judged) < min_judged:
        return {**out, "verdict": "INDETERMINATE",
                "reason": f"{len(judged)} judged pairs < {min_judged}: a fleet median over so few verifies nothing"}
    fleet = statistics.median(v["median"] for v in judged)
    threshold = max(floor, k * fleet)
    for v in judged:
        v["verdict"] = "FAIL" if v["median"] > threshold else "PASS"
    verdict = "FAIL" if any(v["verdict"] == "FAIL" for v in judged) else "PASS"
    return {**out, "verdict": verdict, "reason": "", "fleet": fleet, "threshold": threshold}


def next_streaks(prev: dict, pairs: dict) -> dict:
    """PURE. FAIL advances, a judged PASS resets, INSUFFICIENT or absent leaves the streak where it was."""
    out = {k_: int(v) for k_, v in (prev or {}).items() if isinstance(v, int) and v > 0}
    for key, v in pairs.items():
        if v["verdict"] == "FAIL":
            out[key] = out.get(key, 0) + 1
        elif v["verdict"] == "PASS":
            out.pop(key, None)
    return out


def decide(pairs: dict, streaks: dict, streak: int = STREAK) -> tuple[str, list[str]]:
    """PURE. ('fire', paged keys) | ('clear', []) | ('none', []).

    The paged condition is "a pair at the streak", so a FAIL still below the streak is not one: with no pair at the
    streak the run clears (a delivered page's marker goes; nothing is announced unless the registry row opts in).
    'none' is only a pair already at the streak that was NOT judged this run — clearing it would announce a
    resolution nobody measured, and firing it would page on a run that did not see it."""
    paged = sorted(k_ for k_, v in pairs.items() if v["verdict"] == "FAIL" and streaks.get(k_, 0) >= streak)
    if paged:
        return "fire", paged
    if not any(n >= streak for n in streaks.values()):
        return "clear", []
    return "none", []


def pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100 * x:.2f}%"


def alert_body(res: dict, paged: list[str], streaks: dict, lo: int, hi: int) -> str:
    """Entity nouns on every id: `venue BITGET timeframe 1d`, `coin X` — never a bare value beside a count."""
    n = len(paged)
    lines = [f"Track-record price deviation: {n} (venue, timeframe) {'pair' if n == 1 else 'pairs'} recorded calls "
             f"away from the same coin on the other venues for {STREAK}+ consecutive daily runs."]
    ordered = sorted(paged, key=lambda k_: -(res["pairs"][k_]["median"] or 0))
    for key in ordered[:BODY_MAX_PAIRS]:
        v = res["pairs"][key]
        worst = ", ".join(f"coin {c} {pct(d)}" for c, d in v["worst"])
        lines.append(f"- venue {v['venue']} timeframe {v['tf']}: median {pct(v['median'])} from the cross-venue "
                     f"reference over {v['n']} {'call' if v['n'] == 1 else 'calls'} (threshold "
                     f"{pct(res['threshold'])}, run {streaks.get(key, 0)} in a row); worst: {worst}")
    if n > BODY_MAX_PAIRS:
        lines.append(f"- and {n - BODY_MAX_PAIRS} more (the full set is in canary-results.jsonl)")
    lines.append(f"Fleet median {pct(res['fleet'])} over {res['judged']} judged pairs; window "
                 f"{iso(lo)}..{iso(hi)} (trailing 24 h).")
    lines.append("Meaning: those calls were recorded at a price no other venue showed in that hour, the shape of a "
                 "candle window that ended before the call (OPS-SERVED-CANDLE-TRUTH-W1).")
    lines.append(f"Action: dispatch {RECOMMENDED_WAVE}")
    return "\n".join(lines)


def iso(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def metrics_for(res: dict, lo: int, hi: int, total: int | None, excluded: int | None, streaks: dict,
                action: str, paged: list[str]) -> dict:
    pairs = res["pairs"]
    return {
        "window": [iso(lo), iso(hi)],
        "rows_total": total, "rows_excluded_nonpositive_price": excluded,
        "rows_seen": sum(v["rows"] for v in pairs.values()),
        "rows_with_reference": sum(v["n"] for v in pairs.values()),
        "pairs_seen": len(pairs), "pairs_judged": res["judged"],
        "fleet_median": None if res["fleet"] is None else round(res["fleet"], 6),
        "threshold": None if res["threshold"] is None else round(res["threshold"], 6),
        "failing": sorted(f"{k_}={round(v['median'], 4)}" for k_, v in pairs.items() if v["verdict"] == "FAIL"),
        "streaks": dict(sorted(streaks.items())),
        "action": action, "paged": paged, "reason": res["reason"],
    }


# ── I/O seams ────────────────────────────────────────────────────────────────────────────────────────────────────


def pg_user() -> str:
    """Read the role from the container rather than hardcoding it: a wrong -U is an INDETERMINATE we would rather
    not manufacture (same reasoning as book-liveness-canary.py)."""
    try:
        out = subprocess.run(["docker", "exec", PG_CONTAINER, "printenv", "POSTGRES_USER"],
                             capture_output=True, text=True, timeout=20, check=True).stdout.strip()
        return out or "algovault"
    except Exception:  # noqa: BLE001
        return "algovault"


def psql(sql: str) -> str:
    try:
        return subprocess.run(
            ["docker", "exec", "-e", f"PGOPTIONS={PG_OPTIONS}", PG_CONTAINER, "psql", "-U", pg_user(), "-d", PG_DB,
             "-v", "ON_ERROR_STOP=1", "-tA", "-F", "|", "-c", sql],
            capture_output=True, text=True, timeout=150, check=True,
        ).stdout
    except subprocess.CalledProcessError as e:
        raise QueryError(f"psql exit {e.returncode}: {(e.stderr or '').strip()[:200]}") from None
    except Exception as e:  # noqa: BLE001
        raise QueryError(f"{type(e).__name__}: {str(e)[:200]}") from None


def load_state() -> dict:
    try:
        with open(STATE_PATH) as f:
            data = json.load(f)
        return data.get("streaks", {}) if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:  # noqa: BLE001
        log(f"state unreadable, starting fresh: {str(e)[:120]}")
        return {}


def save_state(streaks: dict, at: str) -> None:
    d = os.path.dirname(STATE_PATH) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".track-record-price-deviation.")
    with os.fdopen(fd, "w") as f:
        json.dump({"streaks": streaks, "at": at}, f, sort_keys=True)
    os.replace(tmp, STATE_PATH)


# The two call sites stay LITERAL: check-alert-registry.mjs enumerates alert ids by their position in a
# `[WRAPPER, "<id>", "CRITICAL_PERSISTENT"` call, and a parameterised id would hide them from it.
def fire(body: str) -> None:
    proc = subprocess.run([WRAPPER, "track_record_price_deviation", "CRITICAL_PERSISTENT", "-"], input=body,
                          capture_output=True, text=True, timeout=30)
    log("wrapper exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


def clear(reason: str) -> None:
    with open(os.devnull, "rb") as devnull:
        proc = subprocess.run([WRAPPER, "--clear", "track_record_price_deviation", reason], stdin=devnull,
                              capture_output=True, text=True, timeout=30)
    log("wrapper --clear exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


def record(verdict: str, exit_code: int, metrics: dict) -> None:
    """A recorder failure must never change the verdict; the outcome is printed either way."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import canary_result_log  # noqa: E402 — lives beside this file on the host
        ok, detail = canary_result_log.append_result(CANARY, verdict, exit_code, metrics)
    except Exception as e:  # noqa: BLE001
        ok, detail = False, "import/append raised: %s" % str(e)[:160]
    print("CANARY_RESULT_LOG=%s" % detail if ok else "CANARY_RESULT_LOG_FAILED=%s" % detail, flush=True)


def token_exit(verdict: str) -> int:
    """The token -> exit-code association, as data the self-test asserts (re-coding INDETERMINATE to 0 must fail)."""
    return {"PASS": 0, "FAIL": 0, "INDETERMINATE": EXIT_INDETERMINATE}[verdict]


def emit(verdict: str) -> int:
    print(f"{VERDICT_TOKEN}={verdict}", flush=True)
    return token_exit(verdict)


def print_pairs(res: dict, streaks: dict) -> None:
    """One POSITIVE line per pair seen — judged or not — so a skipped pair never reads like a passing one."""
    for key in sorted(res["pairs"]):
        v = res["pairs"][key]
        log("PAIR " + json.dumps({"venue": v["venue"], "tf": v["tf"], "rows": v["rows"], "n": v["n"],
                                  "median": None if v["median"] is None else round(v["median"], 6),
                                  "threshold": None if res["threshold"] is None else round(res["threshold"], 6),
                                  "verdict": v["verdict"], "streak": streaks.get(key, 0)}, sort_keys=True))


def main() -> int:
    hi = int(time.time())          # the box's clock, read at run time
    lo = hi - WINDOW_S
    at = iso(hi)
    total = excluded = None
    try:
        rows = parse_rows(psql(build_sql(lo, hi)))
        total, excluded = parse_excluded(psql(build_excluded_sql(lo, hi)))
    except (QueryError, ParseError) as e:
        log(f"INDETERMINATE: {e}")
        res = {"pairs": {}, "judged": 0, "fleet": None, "threshold": None, "verdict": "INDETERMINATE",
               "reason": str(e)[:200]}
        record("INDETERMINATE", EXIT_INDETERMINATE, metrics_for(res, lo, hi, total, excluded, {}, "none", []))
        return emit("INDETERMINATE")
    res = judge(rows)
    prev = load_state()
    if res["verdict"] == "INDETERMINATE":
        print_pairs(res, prev)
        log(f"INDETERMINATE: {res['reason']} (rows {len(rows)}, of {total} in the window; {excluded} excluded "
            f"for a non-positive price)")
        record("INDETERMINATE", EXIT_INDETERMINATE, metrics_for(res, lo, hi, total, excluded, prev, "none", []))
        return emit("INDETERMINATE")
    streaks = next_streaks(prev, res["pairs"])
    action, paged = decide(res["pairs"], streaks)
    print_pairs(res, streaks)
    fails = sorted(k_ for k_, v in res["pairs"].items() if v["verdict"] == "FAIL")
    log(f"SUMMARY window={iso(lo)}..{at} rows={len(rows)} of {total} ({excluded} excluded for a non-positive price) "
        f"with_reference={sum(v['n'] for v in res['pairs'].values())} pairs={len(res['pairs'])} "
        f"judged={res['judged']} fleet_median={pct(res['fleet'])} threshold={pct(res['threshold'])} "
        f"fail={fails} action={action} paged={paged}")
    try:
        save_state(streaks, at)
    except Exception as e:  # noqa: BLE001 — fail-open: a state write failure is logged, not paged
        log(f"state write failed: {str(e)[:160]}")
    try:
        if action == "fire":
            fire(alert_body(res, paged, streaks, lo, hi))
        elif action == "clear":
            clear(f"no (venue, timeframe) pair at a {STREAK}-run deviation streak; fleet median {pct(res['fleet'])}")
    except Exception as e:  # noqa: BLE001 — fail-open: the wrapper is the alert path, never the verdict
        log(f"wrapper invoke failed (fail-open): {str(e)[:160]}")
    record(res["verdict"], token_exit(res["verdict"]),
           metrics_for(res, lo, hi, total, excluded, streaks, action, paged))
    return emit(res["verdict"])


def replay_runs(rows: list[Row], run_times: list[int]) -> list[dict]:
    """PURE. Judge each run time's trailing window exactly as main() would, carrying the streaks forward."""
    out, streaks = [], {}
    for t in run_times:
        res = judge([r for r in rows if t - WINDOW_S <= r.t < t])
        if res["verdict"] != "INDETERMINATE":
            streaks = next_streaks(streaks, res["pairs"])
        action, paged = decide(res["pairs"], streaks) if res["verdict"] != "INDETERMINATE" else ("none", [])
        out.append({"at": t, "res": res, "action": action, "paged": paged})
    return out


def replay(days: int, hhmm: str) -> int:
    hh, mm = (int(x) for x in hhmm.split(":"))
    now = int(time.time())
    first = (now // 86_400 - days + 1) * 86_400 + hh * 3600 + mm * 60
    run_times = [first + i * 86_400 for i in range(days) if first + i * 86_400 <= now]
    if not run_times:
        log("REPLAY: no run time inside the window")
        return EXIT_INDETERMINATE
    rows = parse_rows(psql(build_sql(run_times[0] - WINDOW_S, run_times[-1])))
    runs = replay_runs(rows, run_times)
    pages, fail_runs, judged = [], 0, []
    for run in runs:
        res = run["res"]
        fails = sorted(f"{k_}={pct(v['median'])}" for k_, v in res["pairs"].items() if v["verdict"] == "FAIL")
        fail_runs += bool(fails)
        judged.append(res["judged"])
        if run["action"] == "fire":
            pages.append(f"{iso(run['at'])[:10]}:{','.join(run['paged'])}")
        log(f"REPLAY {iso(run['at'])} verdict={res['verdict']} judged={res['judged']} fleet={pct(res['fleet'])} "
            f"threshold={pct(res['threshold'])} fail={fails} action={run['action']} paged={run['paged']}")
    log(f"REPLAY_SUMMARY runs={len(runs)} rows={len(rows)} runs_with_a_fail={fail_runs} fire_runs={len(pages)} "
        f"pages={pages} judged_min={min(judged)} judged_max={max(judged)}")
    return 0


# ── self-test ────────────────────────────────────────────────────────────────────────────────────────────────────


def _raises(fn, exc=Exception) -> bool:
    try:
        fn()
    except exc:
        return True
    except Exception:  # noqa: BLE001 — the wrong exception class is a failed check, not a crash
        return False
    return False


def _fleet(n_pairs: int, dev: float, n_rows: int = 5, t: int = 1_800_000_000) -> list[Row]:
    rows = []
    for i in range(n_pairs):
        for j in range(n_rows):
            rows.append(Row(f"V{i:02d}", "1h", t + j, 2, dev if j % 2 else -dev, f"C{j}"))
    return rows


SELF_TEST_CHECKS = 66   # exact: a deleted check fails the suite as loudly as a broken one


def self_test() -> int:
    """Two-way, vacuity-guarded. Asserts the artifacts the DB seam bypasses (the SQL text, the row parser), the
    token -> exit MAPPING and the rendered page body, not just the verdicts. Nothing here may RAISE: an assertion
    that aborts the suite turns "proven able to fail" into "crashes" and prints no verdict at all — so every check
    is a thunk, and every shared fixture is built through safe()."""
    fails: list[str] = []
    ran = 0

    def ck(name, fn, want):
        nonlocal ran
        ran += 1
        try:
            got = fn()
        except Exception as e:  # noqa: BLE001
            fails.append(f"{name}: RAISED {type(e).__name__}: {e}")
            return
        if got != want:
            fails.append(f"{name}: got {got!r} want {want!r}")

    def safe(name, fn, default):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            fails.append(f"fixture {name}: RAISED {type(e).__name__}: {e}")
            return default

    # 1. the SQL text — the seam bypasses it, so its shape is asserted here
    sql = safe("build_sql", lambda: build_sql(1_000, 2_000), "")
    ck("sql: half-open window", lambda: "created_at >= 1000 AND created_at < 2000" in sql, True)
    ck("sql: hour bucket in b and in the join", lambda: sql.count("t / 3600"), 3)
    ck("sql: other venues only", lambda: "b.ex <> a.ex" in sql, True)
    ck("sql: NULL exchange is HL", lambda: "coalesce(exchange, 'HL')" in sql, True)
    ck("sql: non-positive price excluded", lambda: "price_at_signal > 0" in sql, True)
    ck("sql: LEFT JOIN keeps unreferenced rows", lambda: "LEFT JOIN" in sql, True)
    ck("sql: coin is the last column", lambda: sql.rstrip().endswith("END, coin FROM r"), True)
    ck("sql: one row per signal id", lambda: "GROUP BY a.id," in sql, True)
    ck("sql: refuses a string bound", lambda: _raises(lambda: build_sql("1000; DROP TABLE signals", 2_000),
                                                      ValueError), True)
    ck("sql: refuses a bool bound", lambda: _raises(lambda: build_sql(True, 2_000), ValueError), True)
    ck("sql: refuses lo >= hi", lambda: _raises(lambda: build_sql(2_000, 2_000), ValueError), True)
    ck("sql: refuses a zero bucket", lambda: _raises(lambda: build_sql(1_000, 2_000, 0), ValueError), True)
    ck("excluded sql: same window, the predicate negated",
       lambda: "NOT (price_at_signal > 0)" in build_excluded_sql(1_000, 2_000)
       and "created_at >= 1000 AND created_at < 2000" in build_excluded_sql(1_000, 2_000), True)

    # 2. the parser
    ck("parse: one referenced row", lambda: parse_rows("BITGET|1d|1792600000|4|-0.0645|BTC\n"),
       [Row("BITGET", "1d", 1792600000, 4, -0.0645, "BTC")])
    ck("parse: an unreferenced row has dev None", lambda: parse_rows("HL|5m|1792600000|0||PURR")[0].dev, None)
    ck("parse: a coin carrying the separator", lambda: parse_rows("XT|3m|1|1|0.01|A|B")[0].coin, "A|B")
    ck("parse: a non-ASCII coin", lambda: parse_rows("XT|3m|1|1|0.01|龙虾")[0].coin, "龙虾")
    ck("parse: blank lines skipped", lambda: len(parse_rows("\nOKX|1h|1|1|0.001|ETH\n\n")), 1)
    ck("parse: empty output is zero rows, not an error", lambda: parse_rows(""), [])
    ck("parse: a short line is a ParseError", lambda: _raises(lambda: parse_rows("OKX|1h|1|1|0.1"), ParseError), True)
    ck("parse: a non-int time is a ParseError",
       lambda: _raises(lambda: parse_rows("OKX|1h|x|1|0.1|ETH"), ParseError), True)
    ck("parse: nref 0 with a dev is a ParseError",
       lambda: _raises(lambda: parse_rows("OKX|1h|1|0|0.1|ETH"), ParseError), True)
    ck("parse: nref > 0 without a dev is a ParseError",
       lambda: _raises(lambda: parse_rows("OKX|1h|1|2||ETH"), ParseError), True)
    ck("parse excluded", lambda: parse_excluded("336134|9\n"), (336134, 9))
    ck("parse excluded: garbage is a ParseError", lambda: _raises(lambda: parse_excluded("x"), ParseError), True)

    # 3. judge, both ways
    t0 = 1_800_000_000
    clean = safe("clean fleet", lambda: _fleet(30, 0.002), [])
    rc = safe("judge(clean)", lambda: judge(clean), {})
    ck("judge: a clean fleet PASSes", lambda: rc["verdict"], "PASS")
    ck("judge: every clean pair judged", lambda: rc["judged"], 30)
    ck("judge: the floor binds on a calm fleet", lambda: rc["threshold"], FLOOR)
    # |dev| 8 % / 6.45 % / 6.45 % / 5 %: median 6.45 %, and C0 is the unambiguous worst coin
    bad = clean + [Row("BITGET", "1d", t0 + j, 3, d, f"C{j}") for j, d in enumerate((0.08, -0.0645, 0.0645, -0.05))]
    rb = safe("judge(bad)", lambda: judge(bad), {})
    ck("judge: a planted stale pair FAILs the run", lambda: rb["verdict"], "FAIL")
    ck("judge: exactly that pair FAILs",
       lambda: sorted(k_ for k_, v in rb["pairs"].items() if v["verdict"] == "FAIL"), ["BITGET|1d"])
    ck("judge: its median is the median |dev|", lambda: round(rb["pairs"]["BITGET|1d"]["median"], 4), 0.0645)
    ck("judge: the worst coins are ranked", lambda: [c for c, _ in rb["pairs"]["BITGET|1d"]["worst"]][:1], ["C0"])
    thin = clean + [Row("BITGET", "1d", t0 + j, 3, 0.2, "X") for j in range(N_MIN - 1)]
    ck("judge: a pair below N_MIN is INSUFFICIENT", lambda: judge(thin)["pairs"]["BITGET|1d"]["verdict"],
       "INSUFFICIENT")
    ck("judge: an INSUFFICIENT pair does not FAIL the run", lambda: judge(thin)["verdict"], "PASS")
    unref = clean + [Row("WEEX", "4h", t0 + j, 0, None, "Y") for j in range(9)]
    ck("judge: rows without a reference count in rows, not in n",
       lambda: (judge(unref)["pairs"]["WEEX|4h"]["rows"], judge(unref)["pairs"]["WEEX|4h"]["n"]), (9, 0))
    volatile = safe("volatile fleet", lambda: _fleet(30, 0.012), []) + \
        [Row("BITGET", "1d", t0 + j, 3, 0.06, "Z") for j in range(4)]
    ck("judge: K x fleet lifts the bar on a market-wide move", lambda: round(judge(volatile)["threshold"], 4), 0.12)
    ck("judge: a 6 % pair on a 1.2 % fleet PASSes", lambda: judge(volatile)["pairs"]["BITGET|1d"]["verdict"], "PASS")
    at_floor = clean + [Row("BITGET", "1d", t0 + j, 3, FLOOR, "Z") for j in range(4)]
    ck("judge: exactly at the floor PASSes (strictly above FAILs)",
       lambda: judge(at_floor)["pairs"]["BITGET|1d"]["verdict"], "PASS")
    above = clean + [Row("BITGET", "1d", t0 + j, 3, FLOOR + 1e-4, "Z") for j in range(4)]
    ck("judge: just above the floor FAILs", lambda: judge(above)["pairs"]["BITGET|1d"]["verdict"], "FAIL")
    ck("judge: zero rows is INDETERMINATE", lambda: judge([])["verdict"], "INDETERMINATE")
    ck("judge: too few judged pairs is INDETERMINATE",
       lambda: judge(_fleet(MIN_JUDGED_PAIRS - 1, 0.002))["verdict"], "INDETERMINATE")
    ck("judge: MIN_JUDGED_PAIRS judged pairs is enough", lambda: judge(_fleet(MIN_JUDGED_PAIRS, 0.002))["verdict"],
       "PASS")

    # 4. streaks and the page decision
    F, P, INS = {"verdict": "FAIL"}, {"verdict": "PASS"}, {"verdict": "INSUFFICIENT"}
    s1 = safe("streak 1", lambda: next_streaks({}, {"BITGET|1d": F}), {})
    s2 = safe("streak 2", lambda: next_streaks(s1, {"BITGET|1d": F}), {})
    ck("streak: first FAIL", lambda: s1, {"BITGET|1d": 1})
    ck("streak: first FAIL does not page (nothing at the streak: clear)", lambda: decide({"BITGET|1d": F}, s1)[0],
       "clear")
    ck("streak: second FAIL pages", lambda: decide({"BITGET|1d": F}, s2), ("fire", ["BITGET|1d"]))
    ck("streak: INSUFFICIENT neither advances nor resets", lambda: next_streaks(s2, {"BITGET|1d": INS}),
       {"BITGET|1d": 2})
    ck("streak: absent neither advances nor resets", lambda: next_streaks(s2, {"OKX|1h": P}), {"BITGET|1d": 2})
    ck("decide: a paged pair not judged this run is neither fired nor cleared",
       lambda: decide({"BITGET|1d": INS}, next_streaks(s2, {"BITGET|1d": INS})), ("none", []))
    ck("streak: a judged PASS resets", lambda: next_streaks(s2, {"BITGET|1d": P}), {})
    ck("decide: nothing at the streak clears", lambda: decide({"BITGET|1d": P}, {}), ("clear", []))
    ck("decide: a FAIL below the streak clears, it never fires", lambda: decide({"OKX|1h": F}, {"OKX|1h": 1}),
       ("clear", []))
    ck("streak: garbage state is dropped", lambda: next_streaks({"a": "x", "b": -1, "c": 1}, {}), {"c": 1})

    # 5. the token -> exit mapping (a self-test that only asserts token strings stays green when this is re-coded)
    ck("exit: PASS 0", lambda: token_exit("PASS"), 0)
    ck("exit: FAIL 0 (the page is the action)", lambda: token_exit("FAIL"), 0)
    ck("exit: INDETERMINATE 3", lambda: token_exit("INDETERMINATE"), 3)

    # 6. the rendered page body — the body is what the operator reads, so it is asserted, not just the action
    body = safe("alert_body", lambda: alert_body(rb, ["BITGET|1d"], {"BITGET|1d": 2}, 1_792_600_000, 1_792_686_400),
                "")
    ck("body: entity nouns", lambda: "venue BITGET timeframe 1d" in body, True)
    ck("body: the median as a percent", lambda: "median 6.45%" in body, True)
    ck("body: the threshold", lambda: "threshold 4.00%" in body, True)
    ck("body: coins carry their noun", lambda: "coin C0 8.00%" in body, True)
    ck("body: singular pair", lambda: "1 (venue, timeframe) pair recorded" in body, True)
    ck("body: the templated action",
       lambda: body.rstrip().endswith("Action: dispatch OPS-SERVED-CANDLE-TRUTH-W{NEXT}"), True)
    many = {f"V{i:02d}|1h": {"venue": f"V{i:02d}", "tf": "1h", "rows": 5, "n": 5, "median": 0.05 + i / 1000,
                             "worst": [("C", 0.05)], "verdict": "FAIL"} for i in range(BODY_MAX_PAIRS + 3)}
    big = safe("big body", lambda: alert_body({"pairs": many, "threshold": 0.04, "fleet": 0.002, "judged": 140},
                                              sorted(many), {}, 1, 2), "")
    ck("body: bounded, with the remainder counted",
       lambda: "and 3 more" in big and big.count("\n- venue") == BODY_MAX_PAIRS, True)

    # 7. the result record fits the recorder's bound for a large fleet with many failures
    def record_fits():
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import canary_result_log as crl
        wide = {f"V{i:03d}|1h": {"venue": f"V{i:03d}", "tf": "1h", "rows": 9, "n": 9, "median": 0.05,
                                 "worst": [], "verdict": "FAIL"} for i in range(60)}
        rec = crl.build_record(CANARY, "FAIL", 0, metrics_for(
            {"pairs": wide, "judged": 140, "fleet": 0.002, "threshold": 0.04, "reason": ""}, 1, 2, 11_000, 0,
            {k_: 2 for k_ in wide}, "fire", sorted(wide)), at="2026-10-22T00:00:00Z", host="signal-1")
        return len(rec.encode()) <= crl.MAX_LINE_BYTES
    ck("record: 60 failing pairs stay under MAX_LINE_BYTES", record_fits, True)

    # 8. replay judges each trailing window, half-open, carrying streaks
    day = 86_400
    stale = [Row("BITGET", "1d", t0 + d * day + 60 * j, 3, 0.07, f"C{j}") for d in range(3) for j in range(4)]
    fleet = [Row(f"V{i:02d}", "1h", t0 + d * day + 60 * j, 2, 0.002, f"C{j}")
             for d in range(3) for i in range(30) for j in range(4)]
    runs = safe("replay", lambda: replay_runs(stale + fleet, [t0 + day, t0 + 2 * day, t0 + 3 * day]), [])
    ck("replay: a stale pair FAILs every run", lambda: [x["res"]["verdict"] for x in runs], ["FAIL", "FAIL", "FAIL"])
    ck("replay: it pages on the second run and stays paged", lambda: [x["action"] for x in runs],
       ["clear", "fire", "fire"])
    ck("replay: a window is half-open at its end",
       lambda: sum(v["rows"] for v in replay_runs(fleet, [t0 + day])[0]["res"]["pairs"].values()), 30 * 4)

    if ran != SELF_TEST_CHECKS:
        fails.append(f"vacuity: {ran} checks ran, the suite declares {SELF_TEST_CHECKS}")
    if fails:
        for f in fails:
            print(f"SELF-TEST: FAIL {f}")
        print(f"SELF-TEST: FAIL ({len(fails)} of {ran})")
        return 1
    print(f"SELF-TEST: PASS ({ran} checks)")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--self-test"]:
        sys.exit(self_test())
    if args[:1] == ["--replay"]:
        try:
            n_days = int(args[1])
            hhmm = args[args.index("--at") + 1] if "--at" in args else "08:29"
            sys.exit(replay(n_days, hhmm))
        except (QueryError, ParseError, ValueError, IndexError) as e:
            log(f"REPLAY failed: {e}")
            sys.exit(EXIT_INDETERMINATE)
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — an uncaught exception would print no token: the one forbidden outcome
        log(f"INDETERMINATE: unexpected {type(e).__name__}: {str(e)[:200]}")
        print(f"{VERDICT_TOKEN}=INDETERMINATE", flush=True)
        sys.exit(EXIT_INDETERMINATE)

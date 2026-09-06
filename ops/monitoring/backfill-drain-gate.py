#!/usr/bin/env python3
"""backfill-drain-gate.py — OPS-OUTCOME-BACKFILL-STALL-W1 A2.

THE BLOCKING GATE BETWEEN A1 (the producer fix) AND A3 (the re-keyed canary).

── Why a gate and not a look ────────────────────────────────────────────────────────────────
A3 re-keys `outcome-backfill-freshness` from `max(created_at) FILTER (pfe_return_pct IS NOT
NULL)` to `max(outcome_filled_at)`. Under this wave's measured cause — QUEUE-WINDOW STARVATION —
the producer was writing continuously the whole time it was paging, so the re-keyed metric reads
~0 lag REGARDLESS of whether A1 worked. Shipping A3 against an undrained queue would therefore
replace a TRUE alarm with a green light over a still-frozen public series, which is strictly
worse than the outage. The re-key is only honest once the queue has demonstrably drained, and
"demonstrably" has to mean a measurement, not a glance at one reading.

── What it measures (CORRECTED 2026-09-06, b1) ──────────────────────────────────────────────
  * CUMULATIVE NET DRAIN — `backlog[last] - backlog[first]` over the whole span, which IS
    `arrivals - fills` by definition. Negative means draining.
  * A PROJECTION to the only threshold that matters — the time for the UNCAPPED backlog to fall
    below the producer's own cap, against a horizon DERIVED from the alarm's own STALE_HOURS.
  * PRODUCER WRITING — `matured_total` strictly rising. A queue that empties because emission
    stopped is not a drain.

The uncapped backlog is `count(*) WHERE outcome_price IS NULL`, with NO LIMIT, while the frontier
is read from the CAPPED window. Never aggregate over the LIMIT-capped read: both sides would come
from the same capped array and the gate would confirm the tree matches itself.

FRONTIER AGE IS REPORTED, NOT A GATE LEG, and that is the correction. The first version required
frontier age AND backlog to fall STRICTLY MONOTONICALLY across three samples. Backlog is
`arrivals - fills` over a bursty ~860/h arrival process, so strict monotonicity tests the ARRIVAL
RATE, not producer throughput — the population-vs-producer conflation this whole wave exists to
retire, reproduced inside the gate built to verify the fix for it. Measured on the first live
series: net drain **-599 rows over 2h** (filled 1,470 vs emitted 871 — genuinely draining),
reported FAIL on sample noise (ages_h [10.22, 9.32, 9.77], backlog [10884, 10043, 10235]).
The correction was made and RE-BASELINED on the pre-fix state BEFORE the producer change it
judges was allowed to land, so a later PASS is attributable to the fix and not to the gate.

── The 3-reading rule ───────────────────────────────────────────────────────────────────────
A single before/after pair cannot distinguish a drain from the ~2x productive phase that follows
every process restart — measured at diagnosis, the frontier advanced 23m13s of `created_at` in
11m38s of wall clock and STILL sat 11.3h behind, and the hourly series showed only 0.52h of
catch-up per hour. Three consecutive readings, each at least MIN_GAP_S apart, is the smallest
window that separates a trend from a burst. Readings are accumulated across invocations in a
state file, so the operator runs this once an hour rather than holding a process open.

── Contract ─────────────────────────────────────────────────────────────────────────────────
Exactly one terminal `BACKFILL_DRAIN_VERDICT=PASS|FAIL|INDETERMINATE`.
Exit 0 = PASS · 0 = FAIL (the verdict is the action; callers gate on the TOKEN, never the code)
      · 3 = INDETERMINATE — the token-law default for a new gate.
FEWER THAN 3 READINGS IS INDETERMINATE, NOT PASS. This gate constructs its own corpus by
accumulating readings, so an under-filled one means it verified nothing — vacuity, refuse.
A psql failure or an unparseable row is INDETERMINATE: input we were handed and could not parse
is never a pass.

Env / test seams:
  BDG_PSQL_CMD    override the psql command (default: docker exec ... psql -U aoe_readonly ...)
  BDG_STATE_FILE  reading history      BDG_NOW_EPOCH   freeze "now"
  BDG_MIN_GAP_S   min seconds between accepted readings (default 3000, i.e. ~50 min)
  BDG_READINGS    readings required (default 3)
  --self-test     hermetic scenario suite; no DB, temp state
  --show-config   print the resolved configuration; touches no network
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

GATE = "BACKFILL_DRAIN"
STATE_FILE = os.environ.get(
    "BDG_STATE_FILE", "/opt/algovault-monitoring/.alert-state/backfill-drain-gate.json")

# Kept in ONE place and read by the SQL builder below. The producer's own cap lives in
# `src/lib/performance-db.ts` as `BACKFILL_QUEUE_LIMIT`; this file must not drift from it, which
# is why `--show-config` prints it and the self-test asserts the SQL carries it.
QUEUE_LIMIT = int(os.environ.get("BDG_QUEUE_LIMIT", "5000"))
MAX_ATTEMPTS = int(os.environ.get("BDG_MAX_ATTEMPTS", "3"))
ATTEMPT_COOLDOWN_S = int(os.environ.get("BDG_ATTEMPT_COOLDOWN_S", "86400"))

PSQL_DEFAULT = (
    "docker exec crypto-quant-signal-mcp-postgres-1 "
    "psql -U aoe_readonly -d signal_performance -tA"
)


def _int_env(name, default, floor=1):
    try:
        return max(floor, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


MIN_GAP_S = _int_env("BDG_MIN_GAP_S", 3000)
READINGS_REQUIRED = _int_env("BDG_READINGS", 3, floor=2)

# The projection horizon is DERIVED from the alarm this gate exists to clear, never chosen: it is
# `outcome-backfill-freshness`'s own STALE_HOURS (12). If the backlog cannot fall below the
# producer's cap inside that horizon, the queue frontier cannot get inside it either, so a drain
# that slow does not clear the condition the alarm fires on. Overridable for the self-test only.
try:
    PROJECTION_HORIZON_H = float(os.environ.get("BDG_PROJECTION_HORIZON_H", "12"))
except (TypeError, ValueError):
    PROJECTION_HORIZON_H = 12.0


class Indeterminate(Exception):
    """The run verified NOTHING it was supposed to verify. Never laundered into a pass."""


def now_epoch():
    frozen = os.environ.get("BDG_NOW_EPOCH")
    return int(frozen) if frozen else int(time.time())


# ── the query, a pure fn so --self-test can assert the shape the psql seam bypasses ──────────

def build_drain_sql(now):
    """One row: `backlog_uncapped|frontier_created_at|matured_total`.

    The backlog count is UNCAPPED on purpose and the frontier is read from the CAPPED, backed-off
    window on purpose — they are different populations and that difference is the whole
    measurement. Reading both from the capped window would make the gate tautological, which is
    the capped-collection defect this estate has already shipped twice.
    """
    cutoff = int(now) - ATTEMPT_COOLDOWN_S
    visible = (
        "SELECT created_at FROM signals WHERE outcome_price IS NULL"
        " AND (outcome_attempts IS NULL OR outcome_attempts < %d"
        " OR outcome_last_attempt_at IS NULL OR outcome_last_attempt_at <= %d)"
        " ORDER BY created_at ASC LIMIT %d" % (MAX_ATTEMPTS, cutoff, QUEUE_LIMIT)
    )
    return (
        "SET default_transaction_read_only=on; "
        "SELECT (SELECT COUNT(*) FROM signals WHERE outcome_price IS NULL) AS backlog_uncapped, "
        "(SELECT MAX(created_at) FROM (%s) v) AS frontier, "
        "(SELECT COUNT(*) FROM signals WHERE pfe_return_pct IS NOT NULL) AS matured_total;"
        % visible
    )


def parse_reading(stdout):
    """psql -tA rows. Handed input we cannot parse is INDETERMINATE, never a pass.

    An EMPTY frontier is legitimate and is the best possible news — it means the producer can see
    no unfilled work at all — so it parses to None rather than refusing.
    """
    for line in stdout.strip().splitlines():
        if "|" not in line:
            continue  # SET tag / notices
        parts = [p.strip() for p in line.split("|")]
        if len(parts) != 3:
            continue
        backlog, frontier, matured = parts
        if not (backlog.isdigit() and matured.isdigit()):
            continue
        return {
            "backlog": int(backlog),
            "frontier": int(frontier) if frontier.isdigit() else None,
            "matured_total": int(matured),
        }
    raise Indeterminate(
        "no parseable drain row in psql output (got %r)" % stdout.strip()[:200])


def query(now):
    cmd = os.environ.get("BDG_PSQL_CMD", PSQL_DEFAULT)
    out = subprocess.run(cmd.split() + ["-c", build_drain_sql(now)],
                         capture_output=True, text=True, timeout=180)
    if out.returncode != 0:
        raise Indeterminate("psql failed rc=%d: %s" % (out.returncode, out.stderr.strip()[:200]))
    return parse_reading(out.stdout)


# ── pure classification ──────────────────────────────────────────────────────────────────────

def frontier_age_h(reading, at):
    """Age of the newest row the producer can SEE. `None` frontier = nothing pending = age 0."""
    if reading["frontier"] is None:
        return 0.0
    return max(0.0, (at - reading["frontier"]) / 3600.0)


def classify(history, required=None, min_gap_s=None, cap=None, horizon_h=None):
    """PURE. `history` is a list of {'at', 'backlog', 'frontier', 'matured_total'}, oldest first.

    ── CORRECTED 2026-09-06 (A2 b1). THE FIRST VERSION'S INSTRUMENT WAS DEFECTIVE. ────────────
    It required frontier age and backlog to fall STRICTLY MONOTONICALLY across three samples.
    Backlog is `arrivals - fills` over a bursty ~860/h arrival process, so a strict-monotonicity
    test is coupled to the ARRIVAL RATE rather than to producer throughput — the very
    population-vs-producer conflation this whole wave exists to retire, reproduced inside the
    gate meant to verify the fix for it. Measured on the first live series: net drain was
    **-599 rows over 2h** (filled 1,470 vs emitted 871 — genuinely draining) and it returned
    FAIL, on sample-to-sample noise: ages_h [10.22, 9.32, 9.77], backlog [10884, 10043, 10235].

    The correction is NOT a relaxation, and the ordering enforces that: the instrument is fixed
    and RE-BASELINED on the pre-fix state BEFORE the producer change it judges is allowed to
    land. "The gate failed so I widened the gate" is the guard-blunting class this estate has
    recorded seven times.

    ── What it measures now ───────────────────────────────────────────────────────────────────
    CUMULATIVE NET DRAIN over the whole span — `backlog[last] - backlog[first]`, which is
    exactly `arrivals - fills` by definition — plus a PROJECTION to the only threshold that
    matters:

      FAIL           net_drain >= 0            (not draining at all)
      INDETERMINATE  draining, but the projected time for backlog to fall below `cap` exceeds
                     `horizon_h`, or the span cannot support a projection
      PASS           draining AND projected inside `horizon_h` AND producer_writing

    `horizon_h` is DERIVED, never chosen: it is the alarm's own staleness threshold. If the
    backlog cannot reach the cap inside that horizon then the frontier cannot reach it either,
    so a "drain" that slow does not clear the condition the alarm fires on.

    Anything short of `required` readings is INDETERMINATE: this gate builds its own corpus, so
    an under-filled one is vacuity and refusing is the only honest verdict.
    """
    req = READINGS_REQUIRED if required is None else required
    gap = MIN_GAP_S if min_gap_s is None else min_gap_s
    lim = QUEUE_LIMIT if cap is None else cap
    hz = PROJECTION_HORIZON_H if horizon_h is None else horizon_h
    usable = history[-req:] if len(history) >= req else history
    if len(usable) < req:
        return {"verdict": "INDETERMINATE", "reason":
                "only %d of %d readings collected" % (len(usable), req), "checks": []}
    gaps = [usable[i]["at"] - usable[i - 1]["at"] for i in range(1, len(usable))]
    if any(g < gap for g in gaps):
        return {"verdict": "INDETERMINATE", "reason":
                "readings too close together (min gap %ds, saw %s)" % (gap, gaps), "checks": []}

    ages = [frontier_age_h(r, r["at"]) for r in usable]
    backlogs = [r["backlog"] for r in usable]
    matured = [r["matured_total"] for r in usable]
    span_h = (usable[-1]["at"] - usable[0]["at"]) / 3600.0
    net_drain = backlogs[-1] - backlogs[0]          # negative == draining
    fills = matured[-1] - matured[0]
    arrivals = fills + net_drain                     # identity, not a second measurement

    if span_h <= 0:
        return {"verdict": "INDETERMINATE",
                "reason": "span is not positive (%.4fh) — cannot project" % span_h, "checks": []}

    rate_per_h = net_drain / span_h
    draining = net_drain < 0
    over_cap = max(0, backlogs[-1] - lim)
    if not draining:
        eta_h = None
    elif over_cap == 0:
        eta_h = 0.0                                  # already under the cap
    else:
        eta_h = over_cap / abs(rate_per_h)

    producer_writing = all(matured[i] > matured[i - 1] for i in range(1, len(matured)))
    within = eta_h is not None and eta_h <= hz

    checks = [
        ("net_drain_negative", draining,
         "net_drain=%+d over %.2fh (%.1f/h) — fills=%d arrivals=%d; backlog=%s"
         % (net_drain, span_h, rate_per_h, fills, arrivals, backlogs)),
        ("projected_within_horizon", bool(within),
         "backlog=%d cap=%d over_cap=%d eta_h=%s horizon=%.1fh"
         % (backlogs[-1], lim, over_cap,
            "n/a (not draining)" if eta_h is None else "%.1f" % eta_h, hz)),
        ("producer_writing", producer_writing, "matured_total=%s" % matured),
    ]
    # Reported for continuity with the first instrument, and because the frontier age is the
    # quantity the alarm itself keys on — but it is REPORTED, never a pass/fail leg, precisely
    # because its sample-to-sample movement is arrival-coupled.
    info = "frontier_age_h=%s (reported, not a gate leg)" % ["%.2f" % a for a in ages]

    if not draining or not producer_writing:
        verdict = "FAIL"
        reason = "not draining: " + ", ".join(n for n, p, _ in checks if not p)
    elif not within:
        verdict = "INDETERMINATE"
        reason = ("draining at %.1f rows/h, but backlog %d is %d over the cap — projected %.1fh "
                  "to clear, beyond the %.1fh horizon derived from the alarm's own threshold"
                  % (rate_per_h, backlogs[-1], over_cap, eta_h, hz))
    else:
        verdict = "PASS"
        reason = ("draining at %.1f rows/h; backlog %d clears the %d cap in ~%.1fh, inside the "
                  "%.1fh horizon" % (rate_per_h, backlogs[-1], lim, eta_h, hz))
    return {"verdict": verdict, "reason": reason, "checks": checks, "info": info,
            "ages_h": ages, "backlogs": backlogs, "matured": matured,
            "net_drain": net_drain, "span_h": span_h, "eta_h": eta_h}


def render_lines(result):
    """POSITIVE per-check output. A run silently skipped must never look like one that passed."""
    if not result["checks"]:
        return ["CHECK backfill_drain: verdict=%s (%s)" % (result["verdict"], result["reason"])]
    lines = ["CHECK %-24s %-4s %s" % (name, "PASS" if ok else "FAIL", detail)
             for name, ok, detail in result["checks"]]
    if result.get("info"):
        lines.append("INFO  %s" % result["info"])
    return lines


# ── state ────────────────────────────────────────────────────────────────────────────────────

def read_history():
    try:
        with open(STATE_FILE) as fh:
            hist = json.load(fh).get("readings", [])
            return [h for h in hist if isinstance(h, dict) and "at" in h]
    except (OSError, ValueError, TypeError):
        return []


def write_history(history):
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as fh:
            json.dump({"readings": history[-24:]}, fh, indent=1)
    except OSError as e:
        print("  WARN: could not persist state to %s: %s" % (STATE_FILE, e))


def _token_exit_map():
    """ONE meaning, ONE code, and the self-test asserts the MAPPING, not just the token."""
    return {"PASS": 0, "FAIL": 0, "INDETERMINATE": 3}


def main():
    try:
        now = now_epoch()
        reading = query(now)
        reading["at"] = now
        history = read_history()
        # Never let two runs inside the min gap both land: keep the newer, drop the crowded one,
        # so an operator double-run cannot manufacture a third "reading" and force a verdict.
        if history and now - history[-1]["at"] < MIN_GAP_S:
            history[-1] = reading
        else:
            history.append(reading)
        write_history(history)
        result = classify(history)
        for line in render_lines(result):
            print("  " + line)
        print("  READING at=%d backlog=%d frontier_age_h=%.2f matured_total=%d cap=%d"
              % (now, reading["backlog"], frontier_age_h(reading, now),
                 reading["matured_total"], QUEUE_LIMIT))
        print("  %s" % result["reason"])
        print("%s_VERDICT=%s" % (GATE, result["verdict"]))
        return _token_exit_map()[result["verdict"]]
    except Indeterminate as e:
        print("  INDETERMINATE: %s" % e)
        print("%s_VERDICT=INDETERMINATE" % GATE)
        return 3
    except Exception as e:  # noqa: BLE001 — an unexpected fault verified nothing either
        print("  INDETERMINATE: %s: %s" % (type(e).__name__, e))
        print("%s_VERDICT=INDETERMINATE" % GATE)
        return 3


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

# Floor, NOT a target — set to the ACTUAL check count so deleting any scenario trips it.
# Found the hard way while proving this suite can fail: at 18 against 19 real checks, deliberately
# deleting a scenario left exactly 18 and the suite reported PASS. A floor with slack in it is a
# floor that licenses exactly one silent deletion, which is the vacuity hole this line exists to
# close. Raise it in the same edit that adds a scenario.
_SELF_TEST_MIN_CHECKS = 25


def self_test():
    """Hermetic scenarios — no DB, temp state.

    Two-way by construction: every FAIL case has a PASS twin differing in ONE input. The seam
    replaced is psql, so the artifacts it bypasses — the SQL string's shape and the row PARSER —
    are asserted directly. Assertions that would RAISE are wrapped: an assertion that aborts the
    suite is a crash, not a failure, and a crash reports nothing.
    """
    global STATE_FILE
    tmp = tempfile.mkdtemp(prefix="backfill-drain-selftest-")
    STATE_FILE = os.path.join(tmp, "state.json")
    failures, ran = [], []

    def check(name, fn):
        ran.append(name)
        try:
            ok = bool(fn())
        except Exception as e:  # noqa: BLE001 — a raising assertion must REPORT, never abort
            ok, name = False, "%s [raised %s: %s]" % (name, type(e).__name__, e)
        print("  [%s] %s" % ("PASS" if ok else "FAIL", name))
        if not ok:
            failures.append(name)

    T = 1_800_000_000
    G = MIN_GAP_S

    def hist(ages_h, backlogs, matured, gap=None):
        gap = gap or (G + 60)
        out = []
        for i, (a, b, m) in enumerate(zip(ages_h, backlogs, matured)):
            at = T + i * gap
            out.append({"at": at, "frontier": int(at - a * 3600), "backlog": b, "matured_total": m})
        return out

    # ── the SQL string: the artifact the psql seam bypasses ──────────────────────────────────
    sql = build_drain_sql(T)
    check("SQL asks for an UNCAPPED backlog count (never over the capped read)",
          lambda: "(SELECT COUNT(*) FROM signals WHERE outcome_price IS NULL) AS backlog_uncapped" in sql)
    check("SQL reads the frontier from the CAPPED, backed-off window",
          lambda: "LIMIT %d" % QUEUE_LIMIT in sql and "outcome_attempts" in sql)
    check("SQL carries the backoff cutoff derived from `now`",
          lambda: str(T - ATTEMPT_COOLDOWN_S) in sql)
    check("SQL is read-only by declaration",
          lambda: "default_transaction_read_only=on" in sql)
    check("SQL names no outcome VALUE column (Data Integrity: cardinalities + timestamps only)",
          lambda: "outcome_return_pct" not in sql and "pfe_price" not in sql)

    # ── the parser: the other bypassed artifact ──────────────────────────────────────────────
    check("parser reads a well-formed row",
          lambda: parse_reading("11748|1788632173|586414\n") ==
                  {"backlog": 11748, "frontier": 1788632173, "matured_total": 586414})
    check("parser tolerates a psql SET tag line",
          lambda: parse_reading("SET\n11748|1788632173|586414\n")["backlog"] == 11748)
    check("parser treats an EMPTY frontier as 'nothing pending', not as a refusal",
          lambda: parse_reading("0||586414\n")["frontier"] is None)

    def refuses(s):
        try:
            parse_reading(s)
            return False
        except Indeterminate:
            return True
    check("parser REFUSES unparseable output rather than passing", lambda: refuses("ERROR: boom"))
    check("parser REFUSES empty output rather than passing", lambda: refuses(""))

    check("an empty frontier scores age 0 (best case, not an error)",
          lambda: frontier_age_h({"frontier": None}, T) == 0.0)

    # ── classification: every FAIL has a PASS twin differing in ONE input ────────────────────
    #
    # These scenarios were REWRITTEN when the instrument was corrected (b1). The old suite
    # asserted strict monotonicity of frontier age and backlog; those are no longer gate legs,
    # so a scenario demanding FAIL on a stalled frontier now encodes the RETIRED rule. Deleting
    # it silently would have been the absence-fixture trap — it is replaced by the regression
    # test directly below, which pins the exact false-FAIL the old instrument produced.
    good = hist([11.3, 7.0, 2.0], [11800, 9000, 4500], [586000, 587000, 588000])
    check("PASS when it drains, clears the cap inside the horizon, and the producer is writing",
          lambda: classify(good)["verdict"] == "PASS")
    check("REGRESSION (the defect that produced this correction): a NOISY frontier and a "
          "non-monotonic backlog still PASS when the CUMULATIVE net drain clears the cap in time",
          # Shaped from the real 2026-09-06 series that the old instrument false-FAILed:
          # ages 10.22 -> 9.32 -> 9.77 (up at the end), backlog 11800 -> 9000 -> 9500 (up at the
          # end), but net drain -2300 over the span. The old rule failed both legs; the corrected
          # rule reads one cumulative quantity and a projection.
          lambda: classify(hist([10.22, 9.32, 9.77], [11800, 9000, 9500],
                                [586000, 587000, 588000]))["verdict"] == "PASS")
    check("FAIL when the backlog GROWS over the span (net drain >= 0)",
          lambda: classify(hist([11.3, 7.0, 2.0], [11800, 12000, 13000],
                                [586000, 587000, 588000]))["verdict"] == "FAIL")
    check("FAIL when the backlog is exactly FLAT — zero is not draining",
          lambda: classify(hist([11.3, 7.0, 2.0], [11800, 11800, 11800],
                                [586000, 587000, 588000]))["verdict"] == "FAIL")
    check("FAIL when the queue empties but the producer is NOT writing",
          lambda: classify(hist([11.3, 7.0, 2.0], [11800, 9000, 4500],
                                [586000, 586000, 586000]))["verdict"] == "FAIL")
    check("INDETERMINATE when draining but too SLOWLY to clear the cap inside the horizon",
          # -30 rows over ~1.75h against 6,000 over the cap is centuries; draining, not clearing.
          lambda: classify(hist([11.3, 11.2, 11.1], [11030, 11015, 11000],
                                [586000, 587000, 588000]))["verdict"] == "INDETERMINATE")
    check("...and it says so, naming the projected ETA against the derived horizon",
          lambda: "beyond the" in classify(hist([11.3, 11.2, 11.1], [11030, 11015, 11000],
                                                [586000, 587000, 588000]))["reason"])
    check("PASS immediately when the backlog is ALREADY under the cap and still draining",
          lambda: classify(hist([2.0, 1.5, 1.0], [4000, 3500, 3000],
                                [586000, 587000, 588000]))["verdict"] == "PASS")
    check("the horizon is DERIVED, not hardcoded into the verdict: widening it flips the same "
          "slow-drain series from INDETERMINATE to PASS",
          lambda: classify(hist([11.3, 11.2, 11.1], [11030, 11015, 11000],
                                [586000, 587000, 588000]), horizon_h=1e9)["verdict"] == "PASS")
    check("frontier age is REPORTED but is not a gate leg (its movement is arrival-coupled)",
          lambda: "reported, not a gate leg" in classify(good)["info"]
          and not any(n == "frontier_age_falling" for n, _, _ in classify(good)["checks"]))
    check("INDETERMINATE on fewer than the required readings — vacuity, never PASS",
          lambda: classify(good[:2])["verdict"] == "INDETERMINATE")
    check("INDETERMINATE when readings are crowded inside the min gap",
          lambda: classify(hist([11.3, 7.0, 2.0], [11800, 9000, 4500],
                                [586000, 587000, 588000], gap=10))["verdict"] == "INDETERMINATE")

    # ── the token -> exit-code MAPPING, not just the token ───────────────────────────────────
    m = _token_exit_map()
    check("token->exit map is PASS=0 FAIL=0 INDETERMINATE=3",
          lambda: m["PASS"] == 0 and m["FAIL"] == 0 and m["INDETERMINATE"] == 3)
    check("every verdict classify can return has an exit code",
          lambda: all(v in m for v in ("PASS", "FAIL", "INDETERMINATE")))

    n = len(ran)
    ok = not failures and n >= _SELF_TEST_MIN_CHECKS
    if n < _SELF_TEST_MIN_CHECKS:
        print("  VACUITY: only %d checks ran, floor is %d — the suite did not run what it was "
              "built to" % (n, _SELF_TEST_MIN_CHECKS))
    print("SELF-TEST: %s (%d check(s) ran, floor %d, %d failure(s))"
          % ("PASS" if ok else "FAIL", n, _SELF_TEST_MIN_CHECKS, len(failures)))
    print("%s_VERDICT=%s" % (GATE, "PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--self-test", action="store_true",
                    help="hermetic scenario suite; exit non-zero on failure")
    ap.add_argument("--show-config", action="store_true",
                    help="print the resolved configuration; touches no network")
    args = ap.parse_args()
    if args.self_test:
        sys.exit(self_test())
    if args.show_config:
        print("  queue_limit=%d max_attempts=%d cooldown_s=%d" % (QUEUE_LIMIT, MAX_ATTEMPTS, ATTEMPT_COOLDOWN_S))
        print("  readings_required=%d min_gap_s=%d projection_horizon_h=%.1f"
              % (READINGS_REQUIRED, MIN_GAP_S, PROJECTION_HORIZON_H))
        print("  state_file=%s" % STATE_FILE)
        print("  psql_cmd=%s" % os.environ.get("BDG_PSQL_CMD", PSQL_DEFAULT))
        sys.exit(0)
    sys.exit(main())

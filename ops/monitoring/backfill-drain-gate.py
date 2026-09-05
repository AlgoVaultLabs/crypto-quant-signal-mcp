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

── What it measures, and why these two quantities ───────────────────────────────────────────
  * QUEUE FRONTIER AGE — `now - max(created_at)` over the rows the producer can ACTUALLY SEE
    (the capped, backed-off window). This is the quantity that paged 12.1h. If A1 worked, the
    frontier races forward and its age collapses.
  * UNCAPPED BACKLOG — `count(*) WHERE outcome_price IS NULL`, with NO LIMIT. Never aggregate
    over the LIMIT-capped read: both sides would come from the same capped array and the gate
    would confirm the tree matches itself. It was 11,748-11,823 against a 5,000 cap at diagnosis.

Both must improve. Frontier age alone can fall while the backlog grows (the producer chewing the
head faster than emission for one window); backlog alone can fall while the frontier stays pinned
(sediment ageing out with no fresh reach). Neither on its own is a drain.

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


def classify(history, required=None, min_gap_s=None):
    """PURE. `history` is a list of {'at', 'backlog', 'frontier', 'matured_total'}, oldest first.

    PASS requires ALL of:
      * `required` readings, each >= `min_gap_s` after the previous one;
      * frontier age STRICTLY decreasing across every consecutive pair;
      * uncapped backlog non-increasing overall AND strictly lower than the first reading;
      * matured_total strictly increasing (the producer is actually writing, not merely idle —
        a queue that empties because emission stopped is not a drain).
    Anything short of `required` readings is INDETERMINATE: this gate builds its own corpus, so
    an under-filled one is vacuity and refusing is the only honest verdict.
    """
    req = READINGS_REQUIRED if required is None else required
    gap = MIN_GAP_S if min_gap_s is None else min_gap_s
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

    checks = [
        ("frontier_age_falling",
         all(ages[i] < ages[i - 1] for i in range(1, len(ages))),
         "ages_h=%s" % ["%.2f" % a for a in ages]),
        ("backlog_falling",
         backlogs[-1] < backlogs[0] and all(backlogs[i] <= backlogs[i - 1] for i in range(1, len(backlogs))),
         "backlog=%s" % backlogs),
        ("producer_writing",
         all(matured[i] > matured[i - 1] for i in range(1, len(matured))),
         "matured_total=%s" % matured),
    ]
    ok = all(c[1] for c in checks)
    return {"verdict": "PASS" if ok else "FAIL",
            "reason": "all three legs improved" if ok else
                      "not draining: " + ", ".join(n for n, p, _ in checks if not p),
            "checks": checks, "ages_h": ages, "backlogs": backlogs, "matured": matured}


def render_lines(result):
    """POSITIVE per-check output. A run silently skipped must never look like one that passed."""
    if not result["checks"]:
        return ["CHECK backfill_drain: verdict=%s (%s)" % (result["verdict"], result["reason"])]
    return ["CHECK %-22s %-4s %s" % (name, "PASS" if ok else "FAIL", detail)
            for name, ok, detail in result["checks"]]


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
_SELF_TEST_MIN_CHECKS = 19


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
    good = hist([11.3, 7.0, 2.0], [11800, 9000, 6000], [586000, 587000, 588000])
    check("PASS when all three legs improve",
          lambda: classify(good)["verdict"] == "PASS")
    check("FAIL when the frontier age stalls (ONE input changed vs the PASS twin)",
          lambda: classify(hist([11.3, 11.3, 11.3], [11800, 9000, 6000],
                                [586000, 587000, 588000]))["verdict"] == "FAIL")
    check("FAIL when the backlog grows (ONE input changed vs the PASS twin)",
          lambda: classify(hist([11.3, 7.0, 2.0], [11800, 12000, 13000],
                                [586000, 587000, 588000]))["verdict"] == "FAIL")
    check("FAIL when the queue empties but the producer is NOT writing",
          lambda: classify(hist([11.3, 7.0, 2.0], [11800, 9000, 6000],
                                [586000, 586000, 586000]))["verdict"] == "FAIL")
    check("INDETERMINATE on fewer than the required readings — vacuity, never PASS",
          lambda: classify(good[:2])["verdict"] == "INDETERMINATE")
    check("INDETERMINATE when readings are crowded inside the min gap",
          lambda: classify(hist([11.3, 7.0, 2.0], [11800, 9000, 6000],
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
        print("  readings_required=%d min_gap_s=%d" % (READINGS_REQUIRED, MIN_GAP_S))
        print("  state_file=%s" % STATE_FILE)
        print("  psql_cmd=%s" % os.environ.get("BDG_PSQL_CMD", PSQL_DEFAULT))
        sys.exit(0)
    sys.exit(main())

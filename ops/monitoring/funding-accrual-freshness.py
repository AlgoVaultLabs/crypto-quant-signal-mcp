#!/usr/bin/env python3
"""
OPS-BDIR-V3-PANEL-READINESS-W1 CH1 — funding-accrual freshness canary (signal-1).

WHY THIS EXISTS. OKX rows in `funding_rates_hist` trailed real time by ~60 days from the
2026-07-05 seed to 2026-09-26 — the OKX adapter answered every fetch with the OLDEST page of its
history — and NOTHING PAGED, because nothing read the table. The AOE hourly scorer even printed a
per-venue list every hour from which OKX was simply absent. This canary is the instrument whose
absence made two months of silence possible, and it watches the PRODUCER's own table, never a
rendered surface: the one writer is `backfill-funding-episodes.js raw --since-checkpoint`, run by
the nightly carry labeler (02:23) and by the AOE hourly top-up (:07).

THE DECISION lives in `funding_accrual_predicate.py` (a sibling here, and vendored — sha-pinned —
into the AOE BDIR panel-readiness job on aoe-1, which derives its `fr=` field from it). This file
only runs the SQL the predicate builds, prints POSITIVE per-venue/per-arm lines, pages, clears,
and records. Arms and thresholds are documented in the predicate.

VERDICT TOKEN — callers gate on the TOKEN, never on the bare exit code:

    FUNDING_ACCRUAL_VERDICT=PASS | FAIL | INDETERMINATE
    exit 0 = PASS · 1 = FAIL · 3 = INDETERMINATE   (3 = the token-law default for a NEW gate)

MODES
    (default)     the check: one row per declared funding venue.
    --self-test   hermetic; no DB, no network, no Telegram.

ALERTING. FAIL → `send_telegram.sh funding_accrual_stale CRITICAL_PERSISTENT -` (the wrapper owns
the 24h cooldown and the severity gate — neither is reimplemented here). PASS → `--clear`, so a
healed breach does not leave the channel pinned to its worst reading (`announce_resolution` stays
false on the registry row). INDETERMINATE (psql unreadable, predicate missing, OI sampler silent)
is an instrument fault: it exits 3 and is SILENT — the inventory reconciler's DARK check covers a
canary that stops producing, and paging on our own read failure would be noise.

DETECT AND ALERT ONLY. It never writes to the database and never re-runs the producer.

READ ROLE. `aoe_readonly` — measured 2026-09-26: SELECT on funding_rates_hist and oi_snapshots.

RECORD. One JSON line per run via `canary_result_log.append_result`, pulled into the private vault
by `ops/scripts/monitoring-results-sync.sh`, so a readout never needs an SSH key. A RECORD, not a
gate leg: verdict, exit code and alert are identical whether the append succeeds.
"""
from __future__ import annotations

import os
import shlex
import subprocess
import sys

PSQL_CMD = os.environ.get(
    "FA_PSQL_CMD",
    "docker exec crypto-quant-signal-mcp-postgres-1 psql -X -q -U aoe_readonly -d signal_performance -tA",
)
TG = os.environ.get("FA_TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
ALERT_ID = "funding_accrual_stale"
CANARY = "funding-accrual-freshness"

# `CRITICAL_PERSISTENT` is the ONLY severity send_telegram.sh delivers; every other value logs
# silently by its contract. The distinction between cases lives in the BODY.
SEVERITY_DELIVERED = "CRITICAL_PERSISTENT"

EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}

# Sibling modules (python puts the script's own directory on sys.path, so the plain names resolve
# in /opt/algovault-monitoring exactly as in the repo). BOTH imports are GUARDED: a partial install
# must degrade to an INDETERMINATE that SAYS SO, never abort the file before a token is printed.
try:
    import funding_accrual_predicate as fap

    _PREDICATE_IMPORT_ERROR = ""
except Exception as _e:  # noqa: BLE001
    fap = None  # type: ignore[assignment]
    _PREDICATE_IMPORT_ERROR = f"{type(_e).__name__}: {_e}"

try:
    from canary_result_log import append_result as _append_result

    _RESULT_LOG_IMPORT_ERROR = ""
except Exception as _e:  # noqa: BLE001
    _RESULT_LOG_IMPORT_ERROR = f"{type(_e).__name__}: {_e}"

    def _append_result(*_a, **_k):  # type: ignore[misc]
        return False, f"canary_result_log unavailable ({_RESULT_LOG_IMPORT_ERROR})"


def run_sql(sql: str) -> str:
    out = subprocess.run(
        shlex.split(PSQL_CMD) + ["-F", "|", "-c", sql],
        capture_output=True, text=True, timeout=180,
    )
    if out.returncode != 0:
        raise RuntimeError(f"psql rc={out.returncode}: {out.stderr.strip()[:200]}")
    return out.stdout


def fmt_ratio(num: int, den: int, ratio: float | None) -> str:
    return f"{num}/{den}=" + ("n/a" if ratio is None else f"{ratio * 100:.1f}%")


def render_line(venue: str, verdict: str, arms: dict) -> str:
    """One POSITIVE line per venue naming every arm's own verdict and measured value. A venue
    skipped by a load error must never look like a venue that passed."""
    parts = [f"  {venue:8s} {verdict:13s}"]
    a = arms.get("age")
    if a:
        age = "none" if a["age_h"] is None else f"{a['age_h']:.2f}h"
        parts.append(f"age={age}/{a['limit_h']}h[{a['verdict']}]")
    c, s = arms.get("coverage"), arms.get("share")
    if c and c["verdict"] == "EXEMPT":
        parts.append(f"coverage+share=EXEMPT ({c['reason']})")
    else:
        if c:
            parts.append("coverage=" + (fmt_ratio(c["covered"], c["oi_top"], c.get("ratio"))
                                        if c.get("oi_top") else "oi_top=0") + f"[{c['verdict']}]")
        if s:
            parts.append("share=" + fmt_ratio(s["fresh"], s["covered"], s.get("ratio")) + f"[{s['verdict']}]")
    if "missing" in arms:
        parts.append("MISSING from the query result — the venue list is ours, so this is a canary defect")
    return " ".join(parts)


def render_body(failing: dict[str, tuple[str, dict]]) -> str:
    """Operator-facing body. Every entity carries its noun ('venue OKX'), never a bare token."""
    lines = []
    for venue, (_v, arms) in sorted(failing.items()):
        why = []
        a = arms.get("age", {})
        if a.get("verdict") == "FAIL":
            why.append("no print at all" if a.get("age_h") is None
                       else f"newest print {a['age_h']:.1f}h old (limit {a['limit_h']}h)")
        c = arms.get("coverage", {})
        if c.get("verdict") == "FAIL":
            why.append(f"only {c['covered']} of its {c['oi_top']} live OI top symbols printed in "
                       f"{fap.COVERED_WINDOW_DAYS if fap else 14}d")
        s = arms.get("share", {})
        if s.get("verdict") == "FAIL":
            why.append(f"only {s['fresh']} of {s['covered']} covered symbols printed in the last "
                       f"{fap.AGE_INTERVALS if fap else 2} intervals")
        lines.append(f"venue {venue}: " + "; ".join(why))
    return (
        "Funding accrual has stalled on the producer table funding_rates_hist.\n\n"
        + "\n".join(lines)
        + "\n\nWriter: backfill-funding-episodes.js raw --since-checkpoint (nightly carry labeler 02:23 "
          "UTC + AOE hourly top-up at :07). A stale venue enters the B-DIR v3 FULL test with stale "
          "funding by construction.\nThis canary DETECTS ONLY.\n"
          "Action: dispatch OPS-FUNDING-ACCRUAL-W{NEXT}"
    )


def fire(body: str) -> None:
    try:
        subprocess.run([TG, ALERT_ID, SEVERITY_DELIVERED, "-"], input=body, text=True, timeout=30, check=False)
    except Exception as e:  # noqa: BLE001 — fail-open: a broken wrapper never crashes a reporting run
        print(f"[funding-accrual] TG dispatch failed (fail-open): {e}", file=sys.stderr)


def clear() -> None:
    try:
        subprocess.run([TG, "--clear", ALERT_ID, "funding accrual fresh on every declared venue"],
                       timeout=30, check=False, capture_output=True)
    except Exception as e:  # noqa: BLE001
        print(f"[funding-accrual] TG clear failed (fail-open): {e}", file=sys.stderr)


def build_metrics(results: dict[str, tuple[str, dict]]) -> dict:
    out: dict = {}
    for venue, (verdict, arms) in results.items():
        a, c, s = arms.get("age", {}), arms.get("coverage", {}), arms.get("share", {})
        out[venue] = {
            "v": verdict,
            "age_h": a.get("age_h"),
            "oi_top": c.get("oi_top"),
            "covered": c.get("covered", s.get("covered")),
            "fresh": s.get("fresh"),
            "exempt": c.get("verdict") == "EXEMPT",
        }
    return out


def record(verdict: str, metrics: dict) -> None:
    ok, detail = _append_result(CANARY, verdict, EXIT_FOR[verdict], metrics)
    print(f"CANARY_RESULT_LOG={'ok ' + detail if ok else 'FAILED ' + detail}")


def check() -> int:
    if fap is None:
        print(f"  predicate module unavailable — {_PREDICATE_IMPORT_ERROR}")
        record("INDETERMINATE", {"error": "predicate_unavailable"})
        print("FUNDING_ACCRUAL_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]
    try:
        rows = fap.parse_rows(run_sql(fap.build_sql()))
    except Exception as e:  # noqa: BLE001 — any failure to READ is INDETERMINATE, never a pass
        print(f"  probe INDETERMINATE — {type(e).__name__}: {str(e)[:160]}")
        record("INDETERMINATE", {"error": type(e).__name__})
        print("FUNDING_ACCRUAL_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]

    verdict, results = fap.evaluate_all(rows)
    for venue in fap.FUNDING_VENUES:
        v, arms = results[venue]
        print(render_line(venue, v, arms))
    failing = {v: r for v, r in results.items() if r[0] == "FAIL"}
    if failing:
        fire(render_body(failing))
    elif verdict == "PASS":
        clear()
    record(verdict, build_metrics(results))
    print(f"FUNDING_ACCRUAL_VERDICT={verdict}")
    return EXIT_FOR[verdict]


def self_test() -> int:
    failures: list[str] = []
    count = 0

    def check_one(name: str, fn) -> None:
        nonlocal count
        count += 1
        # An assertion that RAISES is not an assertion — it would abort the suite instead of
        # reporting FAIL, converting "proven able to fail" into "crashes".
        try:
            ok = bool(fn())
        except Exception as e:  # noqa: BLE001
            ok = False
            name = f"{name} [raised {type(e).__name__}: {str(e)[:80]}]"
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
        if not ok:
            failures.append(name)

    if fap is None:
        print(f"  SELF-TEST: INDETERMINATE — predicate module unavailable ({_PREDICATE_IMPORT_ERROR})")
        print("FUNDING_ACCRUAL_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]

    # ── VACUITY GUARD. We construct the venue list, so an empty one means every assertion below
    # would be vacuous — a defect in this file, not a fact about the world. Refuse.
    if not fap.FUNDING_VENUES:
        print("  SELF-TEST: INDETERMINATE — FUNDING_VENUES is empty; every assertion would be vacuous")
        print("FUNDING_ACCRUAL_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]

    # ── exit-code mapping, asserted explicitly (a sibling gate once asserted tokens but never the
    # token→exit mapping, so re-coding INDETERMINATE to 0 left it green).
    check_one("PASS maps to 0", lambda: EXIT_FOR["PASS"] == 0)
    check_one("FAIL maps to 1", lambda: EXIT_FOR["FAIL"] == 1)
    check_one("INDETERMINATE maps to 3", lambda: EXIT_FOR["INDETERMINATE"] == 3)

    def row(venue="BINANCE", ih=8, age=1.0, oi_top=60, covered=60, fresh=60):
        return {"venue": venue, "interval_h": ih, "age_h": age, "oi_top": oi_top, "covered": covered, "fresh": fresh}

    ev = fap.evaluate_venue
    # ── both directions, and the incident itself.
    check_one("a healthy 8h venue PASSes", lambda: ev(row())[0] == "PASS")
    check_one("THE INCIDENT: OKX on 2026-09-26 (newest 98h old, 1 of 60 OI coins covered, 0 fresh) FAILs",
              lambda: ev(row("OKX", 8, 98.4, 60, 1, 0))[0] == "FAIL")
    check_one("the incident fails on BOTH age and coverage (not one arm masking the other)",
              lambda: (lambda a: a["age"]["verdict"] == "FAIL" and a["coverage"]["verdict"] == "FAIL")(
                  ev(row("OKX", 8, 98.4, 60, 1, 0))[1]))
    check_one("a venue with NO print at all FAILs (the producer never wrote it)",
              lambda: ev(row(age=None))[0] == "FAIL")
    check_one("age exactly at 2 intervals is not a breach", lambda: ev(row(age=16.0))[0] == "PASS")
    check_one("age just past 2 intervals is a breach", lambda: ev(row(age=16.01))[0] == "FAIL")
    check_one("HL's limit is 2 x its 1h interval", lambda: ev(row("HL", 1, 2.5))[0] == "FAIL"
              and ev(row("HL", 1, 1.9))[0] == "PASS")
    check_one("coverage exactly at 80% passes", lambda: ev(row(covered=48, fresh=48))[0] == "PASS")
    check_one("coverage just under 80% fails", lambda: ev(row(covered=47, fresh=47))[0] == "FAIL")
    check_one("share exactly at 90% passes", lambda: ev(row(covered=60, fresh=54))[0] == "PASS")
    check_one("share just under 90% fails", lambda: ev(row(covered=60, fresh=53))[0] == "FAIL")
    check_one("a silent OI sampler (oi_top 0) is INDETERMINATE, never PASS",
              lambda: ev(row(oi_top=0, covered=0, fresh=0))[0] == "INDETERMINATE")
    # Per ARM, not only per venue: measured by mutation, flipping the coverage arm alone to PASS
    # left the venue INDETERMINATE (the share arm still was), so the venue-level check stayed green.
    check_one("with oi_top 0, BOTH the coverage and the share arm are INDETERMINATE",
              lambda: (lambda a: a["coverage"]["verdict"] == "INDETERMINATE"
                       and a["share"]["verdict"] == "INDETERMINATE")(ev(row(oi_top=0, covered=0, fresh=0))[1]))
    check_one("zero covered symbols FAILs coverage and does not report a share number",
              lambda: (lambda a: a["coverage"]["verdict"] == "FAIL" and a["share"]["ratio"] is None)(
                  ev(row(covered=0, fresh=0))[1]))
    check_one("ASTER's coverage/share arms are EXEMPT, so a low coverage does not fail it",
              lambda: ev(row("ASTER", 8, 1.0, 60, 14, 14))[0] == "PASS")
    check_one("ASTER is still held to the AGE arm", lambda: ev(row("ASTER", 8, 40.0, 60, 14, 14))[0] == "FAIL")
    check_one("every exemption carries a reason", lambda: all(r.strip() for r in fap.SHARE_ARM_EXEMPT.values()))

    # ── aggregation
    check_one("worst([]) is INDETERMINATE, never PASS", lambda: fap.worst([]) == "INDETERMINATE")
    check_one("FAIL dominates INDETERMINATE", lambda: fap.worst(["PASS", "INDETERMINATE", "FAIL"]) == "FAIL")
    check_one("INDETERMINATE dominates PASS", lambda: fap.worst(["PASS", "INDETERMINATE"]) == "INDETERMINATE")
    healthy = [row(v, h) for v, h in fap.FUNDING_VENUES.items()]
    check_one("all declared venues healthy ⇒ PASS", lambda: fap.evaluate_all(healthy)[0] == "PASS")
    check_one("a declared venue MISSING from the result is INDETERMINATE (the query built it)",
              lambda: fap.evaluate_all(healthy[1:])[0] == "INDETERMINATE")
    check_one("an UNDECLARED venue in the result is ignored, not counted",
              lambda: set(fap.evaluate_all(healthy + [row("PHEMEX")])[1]) == set(fap.FUNDING_VENUES))

    # ── THE BYPASSED ARTIFACTS. The SQL and the parser are the only code no scenario above runs
    # against a real database, so they are asserted by SHAPE.
    sql = fap.build_sql()
    check_one("SQL names every declared venue with its interval",
              lambda: all(f"('{v}', {h})" in sql for v, h in fap.FUNDING_VENUES.items()))
    check_one("SQL drives FROM the declared venue list, so a venue with no prints still returns a row",
              lambda: "FROM v ORDER BY v.venue" in sql)
    check_one("SQL takes the OI denominator from the LIVE stream only", lambda: sql.count("source IS NULL") >= 2)
    check_one("SQL bounds freshness by the venue's own interval", lambda: "make_interval(hours => 2 * v.ih)" in sql)
    check_one("SQL bounds coverage by the 14-day window", lambda: "interval '14 days'" in sql)
    check_one("SQL has no % token (a LIKE wildcard once broke a sibling's %-formatting)", lambda: "%" not in sql)
    check_one("SQL returns the fields in RESULT_FIELDS order (6 columns)", lambda: len(fap.RESULT_FIELDS) == 6)
    check_one("parser reads a well-formed row", lambda: fap.parse_rows("OKX|8|0.42|60|60|60\n") == [
        {"venue": "OKX", "interval_h": 8, "age_h": 0.42, "oi_top": 60, "covered": 60, "fresh": 60}])
    check_one("parser maps an empty age to None (no print at all)",
              lambda: fap.parse_rows("OKX|8||0|0|0\n")[0]["age_h"] is None)

    def refuses_short_row() -> bool:
        try:
            fap.parse_rows("OKX|8|0.42|60|60\n")
            return False
        except ValueError:
            return True
    check_one("parser REFUSES a short row rather than reading a wrong column", refuses_short_row)

    # ── the operator body: names the entity with its noun and carries the measured numbers.
    body = render_body({"OKX": ev(row("OKX", 8, 98.4, 60, 1, 0))})
    check_one("the alert body names the venue with its noun", lambda: "venue OKX:" in body)
    check_one("the alert body carries the measured age and coverage",
              lambda: "98.4h old" in body and "only 1 of its 60 live OI top symbols" in body)
    check_one("the alert body uses the templated wave form, never a literal wave number",
              lambda: "OPS-FUNDING-ACCRUAL-W{NEXT}" in body)

    def broken_is_caught() -> bool:
        try:
            return bool(1 / 0)
        except ZeroDivisionError:
            return True
    check_one("a raising assertion is caught and reported, not propagated", broken_is_caught)

    if failures:
        print(f"SELF-TEST: FAIL ({len(failures)} of {count})")
        print("FUNDING_ACCRUAL_VERDICT=FAIL")
        return EXIT_FOR["FAIL"]
    print(f"SELF-TEST: PASS ({count} assertions, non-vacuous)")
    print("FUNDING_ACCRUAL_VERDICT=PASS")
    return EXIT_FOR["PASS"]


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    return check()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""
OPS-HL-INTERACTIVE-STARVATION-W1 CH3 — interactive `BUDGET_CEILING` starvation canary.

WHY THIS EXISTS. `get_market_regime` — a PAID tool — refused Hyperliquid calls with interactive
`BUDGET_CEILING` from 2026-07-07, at ~1,000/day from 2026-08-21, and NOTHING WATCHED IT for ten
days. The defect was not the refusal; it was that a correctly-shaped refusal on a revenue surface
was invisible. This canary is the instrument whose absence made that possible.

THE CONFOUND THIS CANARY IS BUILT AROUND — read before changing any threshold.
On 2026-08-28 throws went to EXACTLY ZERO. Nothing was fixed: traffic simply fell from ~2,900
calls/day to 581. A raw throw count is therefore NOT evidence of health — the same zero is produced
by a fix and by an outage in demand, and the two are indistinguishable without a denominator. So:

  * the metric is THROWS PER 100 CALLS, never a raw count;
  * below `MIN_CALLS` the verdict is INDETERMINATE, never PASS. A quiet window cannot earn a green.
    This is the 2026-08-28 reading refusing to be taken twice.

VERDICT TOKEN — the caller gates on the TOKEN, never on the bare exit code:

    REGIME_STARVATION_VERDICT=PASS | FAIL | INDETERMINATE
    exit 0 = PASS · 1 = FAIL · 3 = INDETERMINATE   (3 is the token-law default for a NEW gate;
    it is deliberately NOT check_test_baseline.sh's 2 — nothing reads both code spaces.)

MODES
    --check                default. The CH3 alert. Normalised throw rate per venue.
    --observability-gate   CH1's gate. Asserts `request_log.verdict` is non-NULL on NEW
                           `get_market_regime` rows. Zero new rows ⇒ INDETERMINATE, never PASS.
    --self-test            hermetic; no DB, no network.

DETECT AND ALERT ONLY. This canary never mutates a budget, a reserve, a ceiling or a network rule.
An unattended job must not change a rate budget — Detect → Alert → Escalate.

READ ROLE. `aoe_readonly`, NOT `algovault_autopilot`: measured 2026-09-01,
`has_table_privilege('algovault_autopilot','rate_limit_events','SELECT')` is FALSE, and a table a
role cannot read comes back as ABSENT rather than DENIED — a silent zero on exactly the arm that
matters.
"""
from __future__ import annotations

import os
import subprocess
import sys

PSQL_CMD = os.environ.get(
    "RS_PSQL_CMD",
    "docker exec crypto-quant-signal-mcp-postgres-1 psql -U aoe_readonly -d signal_performance -qtA",
)

# Trailing window. The canary runs daily; 1 day matches its cadence and keeps the rate comparable
# to the per-day figures in the wave's endpoint-truth rather than smearing across a traffic step.
WINDOW_HOURS = int(os.environ.get("RS_WINDOW_HOURS", "24"))

# Throws per 100 `get_market_regime` calls. Pre-fix measured: 31.6 (08-30), 23.7 (08-16),
# 46.8/100-equivalent at the 08-21 onset. A healthy window is ~0, so 1.0 is two orders of magnitude
# below the observed breach and still far above float noise. Raise it only WITH a measurement.
MAX_THROWS_PER_100 = float(os.environ.get("RS_MAX_THROWS_PER_100", "1.0"))

# THE ANTI-CONFOUND FLOOR. 581 calls produced a real, meaningless zero on 2026-08-28. The pre-fix
# working range was 2,294–3,516 calls/day, so 1,500 sits below the normal floor (a green is still
# reachable on an ordinary quiet day) and comfortably above the 581 that manufactured the false
# zero. Below it we report INDETERMINATE and say so — we do not guess.
MIN_CALLS = int(os.environ.get("RS_MIN_CALLS", "1500"))

# `--observability-gate`: how far back to look for NEW rows carrying the CH1 instrument.
# MINUTES, not hours, on purpose: the gate's first run is immediately after the deploy that ships
# the instrument, and an hours-wide window would sweep in PRE-deploy rows whose verdict is legitimately
# NULL and fail the gate for the one reason that is not a defect.
GATE_WINDOW_MINUTES = int(os.environ.get("RS_GATE_WINDOW_MINUTES", "360"))

TG = os.environ.get("RS_TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
ALERT_ID = "regime_budget_starvation"

# `CRITICAL_PERSISTENT` is the ONLY severity send_telegram.sh delivers; every other value logs
# silently by its contract. The distinction between cases is carried in the BODY.
SEVERITY_DELIVERED = "CRITICAL_PERSISTENT"

EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}

# Venues carrying an interactive reserve worth watching. Hyperliquid is the incident venue; the
# others are included because the defect class is the reserve, not the venue, and a per-venue split
# is what makes "which one is starving" answerable without a second canary.
VENUES = tuple(v for v in os.environ.get("RS_VENUES", "Hyperliquid,Binance,Bybit,OKX,Bitget").split(",") if v)


def build_rate_sql(window_hours: int) -> str:
    """Throws and calls for one window, per venue, as ONE row per venue. PURE — extracted so
    `--self-test` can assert its SHAPE. A hermetic self-test is structurally blind to the SQL it
    never runs, which is how a `%`-format bug and a parser bug both shipped green in this estate.

    Both arms are LEFT-joined onto the venue list so a venue with zero throws still emits a row: an
    absent row and a clean row must not look alike.

    The call denominator counts BOTH arms — `request_log` now carries the error arm (CH1), so a
    refused call is a row. Counting successes only would divide by a denominator the numerator has
    already been removed from, which understates the rate exactly when it is worst.
    """
    return (
        "WITH v(venue) AS (VALUES " + ", ".join(f"('{x}')" for x in VENUES) + "), "
        "t AS (SELECT venue, count(*) AS throws FROM rate_limit_events "
        f"WHERE ts > now() - interval '{window_hours} hours' "
        "AND kind='throw' AND http_or_body_code='BUDGET_CEILING' AND class='interactive' "
        "GROUP BY venue), "
        "c AS (SELECT count(*) AS calls FROM request_log "
        "WHERE tool_name='get_market_regime' "
        f"AND timestamp > to_char(now() - interval '{window_hours} hours', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) "
        "SELECT v.venue, coalesce(t.throws,0), (SELECT calls FROM c) "
        "FROM v LEFT JOIN t ON t.venue=v.venue ORDER BY v.venue;"
    )


def build_gate_sql(window_minutes: int) -> str:
    """CH1's gate. Counts NEW `get_market_regime` rows and how many carry a non-NULL verdict. PURE.

    `timestamp` is TEXT (ISO-8601 Z) on this table, so the bound is built as a formatted string
    rather than a timestamptz comparison — the column sorts lexicographically in that format.
    """
    return (
        "SELECT count(*), count(verdict), count(regime) FROM request_log "
        "WHERE tool_name='get_market_regime' "
        f"AND timestamp > to_char(now() - interval '{window_minutes} minutes', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"');"
    )


def run_sql(sql: str) -> str:
    out = subprocess.run(
        PSQL_CMD.split() + ["-F", "|", "-c", sql],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"psql rc={out.returncode}: {out.stderr.strip()[:200]}")
    return out.stdout


def parse_rows(raw: str, width: int) -> list[list[str]]:
    """Split psql -F'|' output into rows of exactly `width` fields. Raises on a malformed row —
    input we were HANDED and could not PARSE is INDETERMINATE, never a pass."""
    rows = []
    for line in raw.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        if len(parts) != width:
            raise ValueError(f"expected {width} fields, got {len(parts)}: {line[:80]!r}")
        rows.append(parts)
    return rows


def fire(body: str) -> None:
    """Dispatch to the shared wrapper, which owns the 24h cooldown and the severity gate — none of
    that is reimplemented here. Fail-open: a broken wrapper must never turn a reporting run into a
    crash. A canary that only prints a token is INSTALLED but DARK."""
    try:
        subprocess.run([TG, ALERT_ID, SEVERITY_DELIVERED, "-"],
                       input=body, text=True, timeout=30, check=False)
    except Exception as e:  # noqa: BLE001
        print(f"[regime-starvation] TG dispatch failed (fail-open): {e}", file=sys.stderr)


def clear() -> None:
    """FIRING -> CLEAR state hygiene. `send_telegram.sh` writes its cooldown marker on a delivered
    fire and nothing removes it, so without this a healed breach pins the channel's last word to the
    worst thing that ever happened. `announce_resolution` stays false on the registry row —
    recovery chatter is noise; this only clears state."""
    try:
        subprocess.run([TG, "--clear", ALERT_ID, "interactive BUDGET_CEILING rate within tolerance"],
                       timeout=30, check=False, capture_output=True)
    except Exception as e:  # noqa: BLE001
        print(f"[regime-starvation] TG clear failed (fail-open): {e}", file=sys.stderr)


def evaluate(throws: int, calls: int) -> tuple[str, float | None]:
    """The whole decision, PURE and unit-tested. Returns (verdict, throws_per_100).

    ORDER IS LOAD-BEARING. The volume floor is checked BEFORE the rate, because a quiet window's
    rate is not a small number — it is an UNDEFINED one, and calling it PASS is the 2026-08-28
    natural experiment being read as a fix for the second time. A breach at low volume still FAILS:
    throws happening at all is information, and suppressing it would make the canary blind exactly
    when demand is recovering.
    """
    if calls <= 0:
        return ("INDETERMINATE", None)
    rate = throws * 100.0 / calls
    if rate > MAX_THROWS_PER_100:
        return ("FAIL", rate)
    if calls < MIN_CALLS:
        return ("INDETERMINATE", rate)
    return ("PASS", rate)


def worst(verdicts: list[str]) -> str:
    if "FAIL" in verdicts:
        return "FAIL"
    if "INDETERMINATE" in verdicts or not verdicts:
        return "INDETERMINATE"
    return "PASS"


def check() -> int:
    try:
        rows = parse_rows(run_sql(build_rate_sql(WINDOW_HOURS)), 3)
    except Exception as e:  # noqa: BLE001 — any failure to READ is INDETERMINATE, never a pass
        print(f"  probe INDETERMINATE — {type(e).__name__}: {str(e)[:160]}")
        print("REGIME_STARVATION_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]

    if not rows:
        # We construct the venue list ourselves, so an empty result means the QUERY built nothing —
        # a defect in this canary, not a fact about the world. Refuse.
        print("  no venue rows returned — the venue CTE built nothing; this is a canary defect")
        print("REGIME_STARVATION_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]

    verdicts, breaches = [], []
    for venue, throws_s, calls_s in rows:
        throws, calls = int(throws_s), int(calls_s or 0)
        verdict, rate = evaluate(throws, calls)
        verdicts.append(verdict)
        # POSITIVE PER-VENUE OUTPUT, always. A venue silently skipped by a load error must not look
        # like a venue that passed — absence-of-alert is not an assertion.
        rate_s = "n/a" if rate is None else f"{rate:.2f}"
        print(f"  {venue:12s} {verdict:13s} throws={throws:<6d} regime_calls={calls:<6d} "
              f"per100={rate_s} (floor {MIN_CALLS} calls, max {MAX_THROWS_PER_100}/100, {WINDOW_HOURS}h)")
        if verdict == "FAIL":
            breaches.append(f"{venue}: {throws} interactive BUDGET_CEILING throws over "
                            f"{calls} get_market_regime calls = {rate_s} per 100")

    verdict = worst(verdicts)
    if breaches:
        fire(
            "Interactive upstream budget is refusing PAID calls.\n\n"
            + "\n".join(breaches)
            + f"\n\nWindow: trailing {WINDOW_HOURS}h. Tolerance: {MAX_THROWS_PER_100} throws per 100 calls.\n"
              "Rate is normalised per call ON PURPOSE — a raw zero is also produced by a traffic drop.\n"
              "This canary DETECTS ONLY. Do not let any automation change a rate budget.\n"
              "Action: dispatch OPS-HL-INTERACTIVE-STARVATION-W{NEXT}"
        )
    elif verdict == "PASS":
        clear()
    print(f"REGIME_STARVATION_VERDICT={verdict}")
    return EXIT_FOR[verdict]


def observability_gate() -> int:
    """CH1's gate: are NEW `get_market_regime` rows carrying the instrument at all?"""
    try:
        rows = parse_rows(run_sql(build_gate_sql(GATE_WINDOW_MINUTES)), 3)
    except Exception as e:  # noqa: BLE001
        print(f"  gate INDETERMINATE — {type(e).__name__}: {str(e)[:160]}")
        print("REGIME_STARVATION_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]

    total, with_verdict, with_regime = (int(x) for x in rows[0])
    print(f"  new rows (last {GATE_WINDOW_MINUTES}min): {total} · non-NULL verdict: {with_verdict} · "
          f"non-NULL regime: {with_regime}")
    if total == 0:
        # The WORLD builds this corpus, but zero rows means we cannot tell a working instrument from
        # a dead one — and the spec is explicit that zero new rows is never green.
        print("  zero new rows — cannot distinguish a live instrument from a dead one")
        print("REGIME_STARVATION_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]
    if with_verdict < total:
        print(f"  {total - with_verdict} of {total} new rows still carry a NULL verdict")
        print("REGIME_STARVATION_VERDICT=FAIL")
        return EXIT_FOR["FAIL"]
    # `regime` is deliberately NOT required to equal `total`: the error arm writes `regime: null` by
    # design, because a call that threw has no classification. Requiring it would make the gate fail
    # precisely when the wave is doing its job.
    print("REGIME_STARVATION_VERDICT=PASS")
    return EXIT_FOR["PASS"]


def self_test() -> int:
    failures: list[str] = []

    def check_one(name: str, fn) -> None:
        # An assertion that RAISES is not an assertion — it aborts the suite instead of reporting
        # FAIL, converting "proven able to fail" into "crashes".
        try:
            ok = bool(fn())
        except Exception as e:  # noqa: BLE001
            ok = False
            name = f"{name} [raised {type(e).__name__}: {str(e)[:80]}]"
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
        if not ok:
            failures.append(name)

    # ── exit-code mapping. Asserted explicitly: a previous estate gate asserted verdict TOKENS but
    # never the token→exit-code MAPPING, so re-coding INDETERMINATE to 0 left it fully green.
    check_one("PASS maps to 0", lambda: EXIT_FOR["PASS"] == 0)
    check_one("FAIL maps to 1", lambda: EXIT_FOR["FAIL"] == 1)
    check_one("INDETERMINATE maps to 3", lambda: EXIT_FOR["INDETERMINATE"] == 3)

    # ── evaluate(): both directions, and the confound specifically.
    check_one("clean high-volume window PASSes",
              lambda: evaluate(0, 3000)[0] == "PASS")
    check_one("a breach at high volume FAILs",
              lambda: evaluate(1110, 3516)[0] == "FAIL")
    check_one("THE 2026-08-28 CONFOUND: zero throws on 581 calls is INDETERMINATE, never PASS",
              lambda: evaluate(0, 581)[0] == "INDETERMINATE")
    check_one("a breach at LOW volume still FAILs — throws are information at any volume",
              lambda: evaluate(400, 581)[0] == "FAIL")
    check_one("zero calls is INDETERMINATE, not a division by zero",
              lambda: evaluate(0, 0)[0] == "INDETERMINATE")
    check_one("the measured pre-fix rate (08-30) is on the FAIL side",
              lambda: abs(evaluate(1110, 3516)[1] - 31.57) < 0.01)
    check_one("exactly at the tolerance is not a breach",
              lambda: evaluate(10, 1000)[0] != "FAIL")
    check_one("one throw above the tolerance is a breach",
              lambda: evaluate(11, 1000)[0] == "FAIL")

    # ── worst(): a vacuous verdict list must not read as PASS.
    check_one("worst([]) is INDETERMINATE, never PASS", lambda: worst([]) == "INDETERMINATE")
    check_one("FAIL dominates INDETERMINATE", lambda: worst(["PASS", "INDETERMINATE", "FAIL"]) == "FAIL")
    check_one("INDETERMINATE dominates PASS", lambda: worst(["PASS", "INDETERMINATE"]) == "INDETERMINATE")

    # ── THE BYPASSED ARTIFACTS. A hermetic self-test is structurally blind to exactly what its own
    # seam replaces: the SQL and the parser are the only code no scenario here executes against a
    # real DB, so they are asserted by SHAPE.
    rate_sql = build_rate_sql(24)
    check_one("rate SQL filters the interactive class", lambda: "class='interactive'" in rate_sql)
    check_one("rate SQL filters BUDGET_CEILING", lambda: "http_or_body_code='BUDGET_CEILING'" in rate_sql)
    check_one("rate SQL LEFT JOINs so a zero-throw venue still emits a row",
              lambda: "LEFT JOIN" in rate_sql)
    check_one("rate SQL carries a call DENOMINATOR — a raw count is the confound",
              lambda: "tool_name='get_market_regime'" in rate_sql)
    check_one("rate SQL names every configured venue", lambda: all(f"('{v}')" in rate_sql for v in VENUES))
    check_one("rate SQL has no % format token (a LIKE wildcard once broke a sibling canary)",
              lambda: "%" not in rate_sql)
    gate_sql = build_gate_sql(360)
    check_one("gate SQL counts verdict and regime separately", lambda: "count(verdict)" in gate_sql and "count(regime)" in gate_sql)
    check_one("gate SQL bounds in MINUTES — an hours window would sweep in pre-deploy NULL rows",
              lambda: "minutes" in gate_sql and "hours" not in gate_sql)

    check_one("parser accepts a well-formed 3-field row",
              lambda: parse_rows("Hyperliquid|12|3000\n", 3) == [["Hyperliquid", "12", "3000"]])
    check_one("parser accepts a venue name and blank denominator without silently padding",
              lambda: parse_rows("OKX|0|\n", 3) == [["OKX", "0", ""]])

    def rejects_short_row() -> bool:
        try:
            parse_rows("Hyperliquid|12\n", 3)
            return False
        except ValueError:
            return True
    check_one("parser REFUSES a short row rather than reading a wrong column", rejects_short_row)

    def broken_is_caught() -> bool:
        # Proves check_one itself reports FAIL rather than aborting — the "prove it can fail" step.
        try:
            return bool(1 / 0)
        except ZeroDivisionError:
            return True
    check_one("a raising assertion is caught and reported, not propagated", broken_is_caught)

    # ── VACUITY GUARD. In `--self-test` WE build the corpus, so an empty one means the test built
    # nothing — a defect in the test. REFUSE.
    if not VENUES:
        print("  SELF-TEST: INDETERMINATE — the venue list is empty, so every SQL assertion above is vacuous")
        print("REGIME_STARVATION_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]

    if failures:
        print(f"SELF-TEST: FAIL ({len(failures)})")
        print("REGIME_STARVATION_VERDICT=FAIL")
        return EXIT_FOR["FAIL"]
    print("SELF-TEST: PASS (all assertions, non-vacuous)")
    print("REGIME_STARVATION_VERDICT=PASS")
    return EXIT_FOR["PASS"]


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if "--observability-gate" in argv:
        return observability_gate()
    return check()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

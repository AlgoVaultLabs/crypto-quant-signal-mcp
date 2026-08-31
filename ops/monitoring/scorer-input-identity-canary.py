#!/usr/bin/env python3
"""scorer-input-identity-canary.py — OPS-SCORER-INPUT-PERSISTENCE-W1 R3 (live half).

Assert, over LIVE captured rows, that the persisted parts reproduce the persisted total:

    (1)  SUM(bucket_i * WEIGHTS_i)                          == raw0
    (2)  raw0 + funding_delta + hurst_delta + squeeze_delta == raw_final

A capture whose parts do not sum to its own total is SILENTLY wrong — every value still looks
like a value — and it would poison every attribution built on the corpus. The fixture half
(`tests/unit/scorer-input-identity.test.ts`) proves the DERIVATION; this proves the WRITER, on
real rows, in the real dialect, with the real column order. Neither substitutes for the other:
a transposed positional bind in an INSERT is invisible to the fixture suite and is exactly the
class this file exists to catch.

VERDICT TOKEN — the caller gates on the TOKEN, never on the bare exit code:

    SCORER_IDENTITY_VERDICT=PASS | FAIL | INDETERMINATE

    exit 0 = PASS           every checked row satisfies both identities
    exit 1 = FAIL           at least one row violates one
    exit 3 = INDETERMINATE  could not verify (probe error, unparseable output, empty corpus)

3 for INDETERMINATE because this is a NEW gate and 3 is the token-law default; it deliberately
does NOT copy `check_test_baseline.sh`'s 2, which is 2 only because that script already deployed
2 for that meaning. Nothing reads both code spaces, so they need no alignment.

VACUITY: zero captured rows is INDETERMINATE, never PASS. This corpus is one WE construct — the
writer is supposed to be filling it on every decision — so empty here means the writer is not
running, which is the single most important thing this canary can tell anyone. (That is the
opposite verdict from a canary observing a corpus the WORLD fills, where empty is a fact and the
honest answer is a reported PASS. The distinction is who was supposed to fill it.)

READS: `docker exec <pg-ctr> psql -U aoe_readonly` — the host-bash psql pattern, never `node -e`
(nested ssh+docker+node quoting mangles SQL string literals). `aoe_readonly` is the role because
it is the only one that can read ALL THREE arms: measured 2026-08-31, `algovault_autopilot`
cannot SELECT `hold_decisions`, so a canary running as that role would silently skip the arm
carrying 94% of the corpus and still print PASS.

Reads only. Writes nothing, alerts nothing on its own — `send_telegram.sh` consumes the token.

    scorer-input-identity-canary.py              # live check
    scorer-input-identity-canary.py --self-test  # hermetic; no DB, no network
    scorer-input-identity-canary.py --show-sql   # print the exact SQL it would run
"""
from __future__ import annotations

import os
import subprocess
import sys

# ── Constants that MUST equal the engine's ───────────────────────────────────────────────────
#
# Restated here rather than imported, because this process cannot import TypeScript — and the
# restatement is the point of the check, not a compromise. If `WEIGHTS` is retuned in
# `src/tools/get-trade-call.ts` and not here, this canary goes RED on the first row written under
# the new ladder. That is the correct behaviour: a retune invalidates every captured row's
# comparability and someone has to acknowledge it. `tests/unit/scorer-input-identity.test.ts`
# pins the same numbers against the live engine on every push, so the drift is caught at push
# time and this is the second net.
W_RSI, W_EMA, W_FUNDING, W_OI, W_VOLUME = 0.30, 0.10, 0.25, 0.15, 0.20

# Mirrors IDENTITY_TOLERANCE in src/lib/scorer-input-codes.ts. Every bucket-times-weight product
# is an integer and every adjustment is an integer, so both identities are exact in real
# arithmetic; evaluated in IEEE-754 doubles the residual is a few ULPs of a value under ~130
# (~1e-14). 1e-9 sits ~5 orders above what rounding can produce and ~9 below the smallest real
# defect (a wrong bucket moves the sum by >= 2).
TOLERANCE = 1e-9

PSQL_CMD = os.environ.get(
    "SI_PSQL_CMD",
    "docker exec crypto-quant-signal-mcp-postgres-1 psql -U aoe_readonly -d signal_performance -qtA",
)

# How far back to check. The canary runs daily; a 2-day window overlaps its own cadence so a row
# is never checked zero times because of a late write or a skipped run.
WINDOW_DAYS = int(os.environ.get("SI_WINDOW_DAYS", "2"))

# Per-arm row cap. A violation is a WRITER defect, so it is systematic rather than rare — a
# bounded sample finds it as surely as a full scan, at a fraction of the cost on a 117k/day table.
# The cap is REPORTED per arm (see `check_arm`), never silent: "no silent caps".
ROW_CAP = int(os.environ.get("SI_ROW_CAP", "20000"))

ARMS = (
    # (arm label, table, decision-time column)
    ("emitted", "signal_scorer_inputs", "decided_at"),
    ("hold", "hold_decisions", "decided_at"),
    ("band", "band_signals", "created_at"),
)


def build_sql(table: str, ts_col: str, window_days: int, cap: int) -> str:
    """The identity query for one arm.

    A PURE FUNCTION, extracted so `--self-test` can assert its SHAPE. A hermetic self-test is
    structurally blind to exactly what its own seam replaces — the query and the parser are the
    only code no scenario would otherwise execute, and both have shipped broken before in this
    estate (a `%`-formatted LIKE clause, and a left-to-right key split). So they are pure, and
    the self-test exercises them directly.

    Both residuals are computed IN SQL rather than in Python: the arithmetic must happen in the
    same IEEE-754 doubles the values are stored as, and pulling 20k rows per arm across the psql
    boundary to subtract them here would be slower and no more correct.

    `raw0 IS NOT NULL` is the capture predicate. On the two ALTERed tables NULL means "written
    before capture shipped" (or with the kill switch off), which is not a violation and must not
    be counted as one — but it is counted SEPARATELY as `uncaptured`, because an arm that is
    silently writing NULLs is the other way this wave fails.
    """
    return (
        "SELECT count(*) FILTER (WHERE raw0 IS NOT NULL) AS captured, "
        "       count(*) FILTER (WHERE raw0 IS NULL) AS uncaptured, "
        "       count(*) FILTER (WHERE raw0 IS NOT NULL AND abs("
        f"         (rsi_score * {W_RSI} + ema_score * {W_EMA} + funding_score * {W_FUNDING} + "
        f"          oi_score * {W_OI} + volume_score * {W_VOLUME}) - raw0) > {TOLERANCE}"
        "       ) AS bad_sum, "
        "       count(*) FILTER (WHERE raw0 IS NOT NULL AND abs("
        "         (raw0 + funding_delta + hurst_delta + squeeze_delta) - raw_final) "
        f"         > {TOLERANCE}) AS bad_chain, "
        "       coalesce(max(abs("
        f"         (rsi_score * {W_RSI} + ema_score * {W_EMA} + funding_score * {W_FUNDING} + "
        f"          oi_score * {W_OI} + volume_score * {W_VOLUME}) - raw0)), 0) AS max_sum_resid, "
        "       coalesce(max(abs("
        "         (raw0 + funding_delta + hurst_delta + squeeze_delta) - raw_final)), 0) "
        "         AS max_chain_resid "
        f"FROM (SELECT * FROM {table} "
        f"      WHERE {ts_col} > extract(epoch from now()) - {window_days} * 86400 "
        f"      ORDER BY {ts_col} DESC LIMIT {cap}) w"
    )


# THE POSITIONAL CONTRACT between `build_sql`'s SELECT list and `parse_row`.
#
# `psql -tA` returns VALUES, never names, so the column ALIASES in the SQL are cosmetic and the
# meaning of each field is its POSITION. Nothing about a reordered SELECT list would look wrong:
# `captured` and `uncaptured` are both counts, and swapping them would silently invert the
# vacuity guard — the run would report a healthy corpus exactly when the writer had stopped.
# So the order lives here once, the parser zips against it, and the self-test asserts the SQL's
# aliases appear in this same order. (Found while proving the self-test can fail: renaming an
# alias is correctly harmless, which is what showed that the ORDER, not the name, is the contract.)
RESULT_KEYS = ("captured", "uncaptured", "bad_sum", "bad_chain", "max_sum_resid", "max_chain_resid")


def parse_row(raw: str) -> dict[str, float]:
    """Parse one `-tA` pipe-separated result row.

    Pure and self-tested for the same reason `build_sql` is. `-tA` emits unaligned rows with `|`
    as the separator and no header; a shape drift here would otherwise surface as a confident
    wrong number rather than an error.
    """
    parts = [p.strip() for p in raw.strip().split("|")]
    if len(parts) != len(RESULT_KEYS):
        raise ValueError(f"expected {len(RESULT_KEYS)} fields, got {len(parts)}: {raw.strip()[:120]!r}")
    return {k: float(v) for k, v in zip(RESULT_KEYS, parts)}


def run_sql(sql: str) -> str:
    out = subprocess.run(
        PSQL_CMD.split() + ["-c", sql],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"psql rc={out.returncode}: {out.stderr.strip()[:200]}")
    return out.stdout


def check_arm(label: str, table: str, ts_col: str) -> tuple[str, dict[str, float]]:
    """Return (verdict, metrics) for one arm. Never raises — an arm that cannot be read is
    INDETERMINATE for that arm, and the run's verdict is the worst of the three."""
    try:
        row = parse_row(run_sql(build_sql(table, ts_col, WINDOW_DAYS, ROW_CAP)))
    except Exception as e:  # noqa: BLE001 — any failure to READ is INDETERMINATE, never a pass
        print(f"  {label:8s} INDETERMINATE — {type(e).__name__}: {str(e)[:160]}")
        return "INDETERMINATE", {}

    captured = int(row["captured"])
    # POSITIVE PER-ARM OUTPUT, always. A row silently skipped by a load error must not look like
    # a row that passed, so every arm prints its measured numbers whatever the verdict.
    print(
        f"  {label:8s} captured={captured} uncaptured={int(row['uncaptured'])} "
        f"bad_sum={int(row['bad_sum'])} bad_chain={int(row['bad_chain'])} "
        f"max_resid=({row['max_sum_resid']:.3e}, {row['max_chain_resid']:.3e}) "
        f"window={WINDOW_DAYS}d cap={ROW_CAP}"
        + (f"  [CAP REACHED — {captured} of an unknown larger set]" if captured >= ROW_CAP else "")
    )

    if captured == 0:
        # Vacuity, per the header: this corpus is one we construct, so empty means the writer is
        # not running. The single most important thing this canary can report.
        print(f"  {label:8s} ⇒ INDETERMINATE (zero captured rows in the window — is the writer running?)")
        return "INDETERMINATE", row
    if int(row["bad_sum"]) or int(row["bad_chain"]):
        print(f"  {label:8s} ⇒ FAIL (parts do not reproduce their own total)")
        return "FAIL", row
    return "PASS", row


ASSERTION_COUNT = 28


def self_test() -> int:
    """Hermetic. No DB, no network — and therefore structurally blind to `run_sql`, which is why
    both artifacts that seam bypasses (`build_sql`, `parse_row`) are asserted directly below.

    Every assertion is wrapped so a broken subject reports FAIL rather than aborting the suite: an
    assertion that RAISES is not an assertion, it is a crash, and a crash at a green exit code is
    how a canary goes dark.
    """
    failures: list[str] = []
    _ran: list[str] = []

    def check(name: str, fn) -> None:
        _ran.append(name)
        try:
            ok = fn()
        except Exception as e:  # noqa: BLE001
            failures.append(f"{name}: raised {type(e).__name__}: {e}")
            return
        if not ok:
            failures.append(name)

    # ── the BYPASSED artifact #1: the SQL string ──
    sql = build_sql("signal_scorer_inputs", "decided_at", 2, 20000)
    check("sql names the table", lambda: "FROM signal_scorer_inputs" in sql)
    # ── the weights, against LITERALS rather than against themselves ──
    #
    # This assertion was FIRST WRITTEN as `all(f"* {w}" in sql for w in (W_RSI, ...))` and was
    # VACUOUS: it asked whether the SQL contains whatever the constants happen to be, which is
    # true for every value they could take. Editing W_RSI to 0.35 left the whole suite green.
    # Caught by deliberately breaking the constant — which is the entire reason that step is
    # mandatory and not ceremony.
    #
    # The literals below are the SECOND, INDEPENDENT statement of the coefficients. Together with
    # `tests/unit/scorer-input-identity.test.ts` (which pins the same numbers against the LIVE
    # engine on every push) they close the loop: that suite catches engine-vs-canary drift, this
    # catches an accidental edit to the canary.
    check("W_RSI is 0.30", lambda: W_RSI == 0.30)
    check("W_EMA is 0.10", lambda: W_EMA == 0.10)
    check("W_FUNDING is 0.25", lambda: W_FUNDING == 0.25)
    check("W_OI is 0.15", lambda: W_OI == 0.15)
    check("W_VOLUME is 0.20", lambda: W_VOLUME == 0.20)
    # And the derived public constant, re-derived rather than quoted. MAX_RAW_SCORE = 89 is the
    # confidence DIVISOR and therefore public copy; if these weights ever stop producing it, the
    # captured corpus and every published confidence number have diverged.
    check("the weights still derive MAX_RAW_SCORE = 89",
          lambda: abs((100 * W_RSI + 100 * W_EMA + 80 * W_FUNDING
                       + 60 * W_OI + 100 * W_VOLUME) - 89) < 1e-9)
    check("every weight reaches the SQL", lambda: all(
        f"* {w}" in sql for w in (W_RSI, W_EMA, W_FUNDING, W_OI, W_VOLUME)))
    check("sql asserts identity (1)", lambda: "- raw0)" in sql)
    check("sql asserts identity (2)", lambda: "squeeze_delta) - raw_final" in sql)
    # ── the tolerance, PER LEG ──
    #
    # First written as `str(TOLERANCE) in sql`, which is a bare EXISTENCE check and was measured
    # to pass while identity (1)'s comparison had been loosened to `> 999` — because the string
    # still appeared on identity (2)'s line. A gate with two legs must assert the bound on BOTH,
    # or half of it can be disabled in silence. Found by deliberately loosening one leg, which is
    # the second defect that step surfaced in this file.
    check("the tolerance bounds BOTH identity legs, not just one",
          lambda: sql.count(f"> {TOLERANCE}") == 2)
    check("identity (1) is bounded by the tolerance",
          lambda: f"- raw0) > {TOLERANCE}" in sql)
    check("identity (2) is bounded by the tolerance",
          lambda: f"- raw_final) \n         > {TOLERANCE}" in sql or f"- raw_final)          > {TOLERANCE}" in sql)
    check("sql bounds the scan", lambda: "LIMIT 20000" in sql)

    def alias_order_matches() -> bool:
        # Positions of each alias in the SELECT list must be strictly increasing in RESULT_KEYS
        # order — the positional contract the parser depends on.
        idx = [sql.index(f"AS {k}") for k in RESULT_KEYS]
        return idx == sorted(idx)
    check("the SELECT list order matches the parser's key order", alias_order_matches)
    check("sql separates uncaptured from violating", lambda: "raw0 IS NULL) AS uncaptured" in sql)
    # The band arm keys on a DIFFERENT timestamp column; a hardcoded `decided_at` would make that
    # arm error out and read as INDETERMINATE forever.
    check("sql honours the per-arm timestamp column",
          lambda: "WHERE created_at >" in build_sql("band_signals", "created_at", 2, 10))

    # ── the BYPASSED artifact #2: the row parser ──
    check("parses a well-formed row", lambda: parse_row("10|2|0|0|1.4e-14|0")["captured"] == 10.0)
    check("parses scientific-notation residuals",
          lambda: parse_row("10|0|0|0|1.42e-14|3.5e-15")["max_sum_resid"] < 1e-13)
    check("parses a zero-row result", lambda: parse_row("0|0|0|0|0|0")["captured"] == 0.0)

    def rejects_short_row() -> bool:
        try:
            parse_row("10|2|0")
        except ValueError:
            return True
        return False
    check("REJECTS a short row rather than guessing", rejects_short_row)

    # ── PROVE THE CHECK CAN FAIL: a deliberately broken subject must be reported, not crash ──
    def broken_is_caught() -> bool:
        bad = parse_row("100|0|7|0|6.0|0")   # 7 rows violating identity (1), residual 6.0
        return int(bad["bad_sum"]) > 0 and bad["max_sum_resid"] > TOLERANCE
    check("a violating result is recognised as violating", broken_is_caught)

    # ── the verdict→exit-code MAPPING, not just the tokens. Asserting tokens alone once left a
    #    sibling gate fully green after its INDETERMINATE mapping was re-coded to 0. ──
    check("PASS maps to 0", lambda: EXIT_FOR["PASS"] == 0)
    check("FAIL maps to 1", lambda: EXIT_FOR["FAIL"] == 1)
    check("INDETERMINATE maps to 3", lambda: EXIT_FOR["INDETERMINATE"] == 3)
    check("worst-of picks FAIL over PASS", lambda: worst(["PASS", "FAIL", "PASS"]) == "FAIL")
    check("worst-of picks INDETERMINATE over FAIL",
          lambda: worst(["FAIL", "INDETERMINATE"]) == "INDETERMINATE")
    check("worst-of an empty arm list is INDETERMINATE, never PASS", lambda: worst([]) == "INDETERMINATE")

    # The advertised count is itself asserted: a printed number nothing checks drifts the
    # first time someone adds an assertion, and then it is decoration rather than evidence.
    if len(_ran) != ASSERTION_COUNT:
        failures.append(f"assertion count drifted: ran {len(_ran)}, ASSERTION_COUNT says {ASSERTION_COUNT}")

    if failures:
        print(f"SELF-TEST: FAIL ({len(failures)})")
        for f in failures:
            print(f"  - {f}")
        print("SCORER_IDENTITY_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]
    print(f"SELF-TEST: PASS ({ASSERTION_COUNT} assertions)")
    print("SCORER_IDENTITY_VERDICT=PASS")
    return 0


EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}

# INDETERMINATE outranks FAIL: "we could not verify" must never be reported as the weaker "we
# verified and it was fine", and it must not be hidden by a sibling arm's clean result either.
_RANK = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 2}


def worst(verdicts: list[str]) -> str:
    """The run's verdict is the worst of its arms. An EMPTY list is INDETERMINATE — no arm was
    evaluated, which is the vacuity case one level up from an empty corpus."""
    if not verdicts:
        return "INDETERMINATE"
    return max(verdicts, key=lambda v: _RANK[v])


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if "--show-sql" in argv:
        for label, table, ts_col in ARMS:
            print(f"-- {label}\n{build_sql(table, ts_col, WINDOW_DAYS, ROW_CAP)}\n")
        return 0

    print(f"scorer-input identity — {len(ARMS)} arms, window={WINDOW_DAYS}d, tolerance={TOLERANCE}")
    verdicts = [check_arm(label, table, ts)[0] for label, table, ts in ARMS]
    verdict = worst(verdicts)
    print(f"SCORER_IDENTITY_VERDICT={verdict}")
    return EXIT_FOR[verdict]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

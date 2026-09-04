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

Reads only (plus one append to the results log; see below). Alerts nothing on its own —
`send_telegram.sh` consumes the token.

── OFF-HOST READOUT — OPS-SCORER-CAPTURE-DAY3-HEALTH-READOUT-W1 R6 ──────────────────────────
This canary's stdout was the ONLY place the running capture counts were published, which made
the scheduled day-N health check undispatchable from anywhere without an SSH credential. It now
also appends one structured JSON line per run via `canary_result_log.append_result`, which
`ops/scripts/monitoring-results-sync.sh` pulls back into the vault.

That record is a RECORD, NOT A GATE LEG. The verdict, the exit code and the alert dispatch are
identical whether the append succeeds or fails — a logging fault must never become a paging
fault. The one thing it may not do is fail SILENTLY, so a positive line is printed either way.

── THE ATTRIBUTION COUNT, AND WHY IT IS A SECOND QUERY ──────────────────────────────────────
`EDGE-SELL-FEATURE-ATTRIBUTION-W{NEXT}` opens on a stated ROW COUNT of captured-and-LABELED
rows — never a date. The identity query CANNOT answer that: it is windowed (2d) and LIMIT-capped
(20k/arm), and measured 2026-09-04 the emitted AND hold arms both sit at that cap, so its
`captured=N` is a bounded sample. Aggregating over it would be the capped-collection defect this
estate has already paid for. The attribution figures are therefore an INDEPENDENT, uncapped,
unwindowed query, and every number carries its instrument (`window_days`, `row_cap`,
`cap_reached`) beside it in the record so a later reader cannot mistake one for the other.

ARM COVERAGE, RATIFIED: attribution counts the WITHHELD arm (`hold_decision_labels`) as well as
the emitted one. Architect ruling 2026-09-04 admits `EDGE-SELL-FEATURE-ATTRIBUTION-W{NEXT}` as
the THIRD consumer of the counterfactual store, under the SAME three protections as the second
(`EDGE-WITHHELD-COUNTERFACTUAL-DWR-W1`): it pre-registers its own hypotheses, its output may
NEVER be cited for or against the HOLD-discipline hypothesis, and nothing derived from it reaches
public copy. What this file reads from that store is a COUNT of labelled parents — never a label
value, never a rate, never a return.

    scorer-input-identity-canary.py              # live check
    scorer-input-identity-canary.py --self-test  # hermetic; no DB, no network
    scorer-input-identity-canary.py --show-sql   # print the exact SQL it would run
"""
from __future__ import annotations

import os
import subprocess
import sys

# The off-host result recorder — a sibling in /opt/algovault-monitoring (python puts the script's
# own directory on sys.path, so the plain name resolves there exactly as it does in the repo).
#
# GUARDED, and not out of habit: an unguarded `import` of a module that is missing — a partial
# install, a rollback of the module alone — would abort this file at LOAD time, and the identity
# verdict would never be computed at all. A recorder taking the gate down is strictly worse than
# a run with no record, so absence degrades to a no-op that SAYS SO.
try:
    from canary_result_log import append_result as _append_result

    _RESULT_LOG_IMPORT_ERROR = ""
except Exception as _import_err:  # noqa: BLE001
    _RESULT_LOG_IMPORT_ERROR = f"{type(_import_err).__name__}: {_import_err}"

    def _append_result(*_a, **_k):  # type: ignore[misc]
        return False, f"canary_result_log unavailable ({_RESULT_LOG_IMPORT_ERROR})"


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

# ── ALERT DISPATCH ───────────────────────────────────────────────────────────────────────────
#
# The canary MUST fire the wrapper itself. A canary that only prints a token is INSTALLED but
# DARK: it exits 0/1/3 on schedule and pages nobody, which is indistinguishable from healthy —
# the failure class this estate has hit four times. `send_telegram.sh` owns the cooldown (24h per
# alert_id), the severity gate and the dry-run lever; none of that is reimplemented here.
TG = os.environ.get("SI_TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
ALERT_ID = "scorer_input_identity"

# WHAT PAGES, AND WHAT DOES NOT — the split is DATA vs INSTRUMENT.
#
#   FAIL                     → PAGES. The parts do not reproduce their own total, so the corpus
#                              is being written WRONG. Forward-only capture means every hour it
#                              continues is unrecoverable, so this pages on the FIRST occurrence
#                              rather than waiting for a consecutive-run confirmation.
#   INDETERMINATE (vacuity)  → PAGES. Zero captured rows means the WRITER STOPPED, which is data
#                              being silently lost — the same urgency as above.
#   INDETERMINATE (probe)    → SILENT. A psql/docker error is an instrument fault, not a data
#                              fault; the monitoring inventory's own DARK check already covers a
#                              canary that stops producing, and paging here would train the
#                              operator to ignore the channel.
#
# `CRITICAL_PERSISTENT` is the ONLY severity send_telegram.sh delivers (every other value logs
# silently, by its contract), so it is used for both paging cases and the distinction is carried
# in the BODY rather than in a severity string the wrapper would drop.
SEVERITY_DELIVERED = "CRITICAL_PERSISTENT"

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


def parse_row(raw: str, keys: tuple[str, ...] = RESULT_KEYS) -> dict[str, float]:
    """Parse one `-tA` pipe-separated result row against a POSITIONAL key tuple.

    Pure and self-tested for the same reason `build_sql` is. `-tA` emits unaligned rows with `|`
    as the separator and no header; a shape drift here would otherwise surface as a confident
    wrong number rather than an error.

    `keys` is a parameter rather than a second parser: the attribution query below has its own
    positional contract, and two copies of this three-line function would be two things that can
    drift apart. The default keeps every existing caller and every existing assertion unchanged.
    """
    parts = [p.strip() for p in raw.strip().split("|")]
    if len(parts) != len(keys):
        raise ValueError(f"expected {len(keys)} fields, got {len(parts)}: {raw.strip()[:120]!r}")
    return {k: float(v) for k, v in zip(keys, parts)}


# ── THE ATTRIBUTION COUNT (R6) ───────────────────────────────────────────────────────────────
#
# The successor's gate quantity: how many CAPTURED rows also carry a triple-barrier label. It is
# deliberately NOT derivable from the identity query — see the module docstring — so it gets its
# own uncapped, unwindowed statement and its own positional contract.
#
# `labeled` is a DISTINCT count of PARENT rows, never a row count of the label table: a parent
# carries up to three `barrier_spec` labels, so counting label rows would triple-count it. Both
# the any-spec figure and the canonical-spec figure are emitted, because they answer different
# questions and a single number would hide which one a reader is holding.
CANONICAL_BARRIER_SPEC = os.environ.get("SI_BARRIER_SPEC", "tau1.0-floor0.30-v1")

ATTRIBUTION_KEYS = (
    "captured_emitted",
    "captured_hold",
    "captured_band",
    "labeled_emitted_any_spec",
    "labeled_emitted_canonical",
    "labeled_hold_any_spec",
    "labeled_hold_canonical",
)


def build_attribution_sql(spec: str = CANONICAL_BARRIER_SPEC) -> str:
    """PURE. One row of uncapped corpus counts. Extracted and self-tested for the same reason
    `build_sql` is — the DB seam is exactly what a hermetic self-test cannot see.

    The emitted arm joins through `signals` on the COMPOSITE `(signal_hash, exchange)` key, never
    on the hash alone: measured 2026-08-31, five duplicate-hash groups differ by venue, so a
    bare-hash join fans out and inflates the count it exists to report.

    The hold arm keys on `hold_decision_id -> hold_decisions.decision_id`, NEVER `signal_id`:
    `request_log.id` and `signals.id` overlap numerically, so a wrong id joins SILENTLY to an
    unrelated acted signal. It reads a COUNT and nothing else from the counterfactual store.
    """
    emitted_join = (
        "FROM signal_scorer_inputs i "
        "JOIN signals s ON s.signal_hash = i.signal_hash AND s.exchange = i.exchange "
        "JOIN directional_labels dl ON dl.signal_id = s.id "
        "WHERE i.raw0 IS NOT NULL"
    )
    hold_join = (
        "FROM hold_decisions h "
        "JOIN hold_decision_labels hl ON hl.hold_decision_id = h.decision_id "
        "WHERE h.raw0 IS NOT NULL"
    )
    return (
        "SELECT "
        "(SELECT count(*) FROM signal_scorer_inputs WHERE raw0 IS NOT NULL) AS captured_emitted, "
        "(SELECT count(*) FROM hold_decisions WHERE raw0 IS NOT NULL) AS captured_hold, "
        "(SELECT count(*) FROM band_signals WHERE raw0 IS NOT NULL) AS captured_band, "
        f"(SELECT count(DISTINCT i.scorer_input_id) {emitted_join}) AS labeled_emitted_any_spec, "
        f"(SELECT count(DISTINCT i.scorer_input_id) {emitted_join} "
        f"   AND dl.barrier_spec = '{spec}') AS labeled_emitted_canonical, "
        f"(SELECT count(DISTINCT h.decision_id) {hold_join}) AS labeled_hold_any_spec, "
        f"(SELECT count(DISTINCT h.decision_id) {hold_join} "
        f"   AND hl.barrier_spec = '{spec}') AS labeled_hold_canonical"
    )


def read_attribution() -> tuple[dict[str, float] | None, str]:
    """Return `(metrics, detail)`. NEVER raises, and NEVER contributes to the verdict.

    This leg is a RECORD, not a gate. A failure here records `null` with a reason and leaves the
    identity verdict, the exit code and the alert dispatch untouched — adding a second way for
    this file to go INDETERMINATE would widen the paging surface for a reporting concern.
    """
    try:
        return parse_row(run_sql(build_attribution_sql()), ATTRIBUTION_KEYS), "ok"
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {str(e)[:140]}"


def run_sql(sql: str) -> str:
    out = subprocess.run(
        PSQL_CMD.split() + ["-c", sql],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"psql rc={out.returncode}: {out.stderr.strip()[:200]}")
    return out.stdout


def fire(body: str) -> None:
    """Dispatch to the shared wrapper. Extracted so it is stubbable — a test must be able to drive
    the real `main()` without posting to the operator channel. Fail-open: a broken wrapper must
    never turn a reporting run into a crash."""
    try:
        subprocess.run([TG, ALERT_ID, SEVERITY_DELIVERED, "-"],
                       input=body, text=True, timeout=30, check=False)
    except Exception as e:  # noqa: BLE001
        print(f"[scorer-input-identity] TG dispatch failed (fail-open): {e}", file=sys.stderr)


def clear() -> None:
    """FIRING -> CLEAR on the healthy path. STATE HYGIENE, not a recovery announcement:
    send_telegram.sh writes its cooldown marker on a delivered fire and nothing else removes it,
    so without this a healed breach would pin the channel's last word to the worst thing that ever
    happened. `announce_resolution` stays false on the registry row — recovery chatter is noise."""
    try:
        subprocess.run([TG, "--clear", ALERT_ID, "identity clean on every captured arm"],
                       timeout=30, check=False, capture_output=True)
    except Exception as e:  # noqa: BLE001
        print(f"[scorer-input-identity] TG clear failed (fail-open): {e}", file=sys.stderr)


def check_arm(label: str, table: str, ts_col: str) -> tuple[str, dict[str, float]]:
    """Return (verdict, metrics) for one arm. Never raises — an arm that cannot be read is
    INDETERMINATE for that arm, and the run's verdict is the worst of the three.

    The returned metrics dict is EMPTY exactly when the read failed, which is how `main` tells an
    instrument fault (silent) from the vacuity case (pages)."""
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


ASSERTION_COUNT = 45


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

    # ── the BYPASSED artifact #3: the ATTRIBUTION SQL (R6) ──
    #
    # Same reasoning as artifacts #1 and #2: the DB seam means this string is never executed by
    # any scenario, so it is asserted directly. Every check below names a defect that would be a
    # confident wrong NUMBER rather than an error.
    asql = build_attribution_sql("tau9.9-fixture-v1")
    check("attribution joins the emitted arm on the COMPOSITE key, never the hash alone",
          lambda: "s.signal_hash = i.signal_hash AND s.exchange = i.exchange" in asql)
    check("attribution keys the hold arm on hold_decision_id, NEVER signal_id",
          lambda: "hl.hold_decision_id = h.decision_id" in asql and "hl.signal_id" not in asql)
    check("attribution counts DISTINCT PARENTS, not label rows",
          lambda: asql.count("count(DISTINCT") == 4)
    check("attribution reads the WITHHELD arm (the ratified third consumer)",
          lambda: "hold_decision_labels" in asql)
    check("attribution filters on the captured predicate, both arms",
          lambda: "i.raw0 IS NOT NULL" in asql and "h.raw0 IS NOT NULL" in asql)
    # The spec literal must actually reach the SQL. Asserted against the ARGUMENT rather than
    # against CANONICAL_BARRIER_SPEC, which would be the vacuous self-comparison this estate has
    # already been bitten by twice (the weight assertion here, the key-order assertion in
    # canary_result_log.py) — it would pass for whatever value the constant happened to hold.
    check("the requested barrier_spec reaches BOTH canonical legs",
          lambda: asql.count("barrier_spec = 'tau9.9-fixture-v1'") == 2)
    # UNCAPPED is the point of this query: a LIMIT here would silently reintroduce the
    # capped-collection defect the identity query's own cap already demonstrates live.
    check("the attribution query is UNCAPPED — no LIMIT, no window",
          lambda: "LIMIT" not in asql and "86400" not in asql)
    check("attribution keys are the declared positional contract",
          lambda: ATTRIBUTION_KEYS == ("captured_emitted", "captured_hold", "captured_band",
                                       "labeled_emitted_any_spec", "labeled_emitted_canonical",
                                       "labeled_hold_any_spec", "labeled_hold_canonical"))

    def attribution_alias_order_matches() -> bool:
        idx = [asql.index(f"AS {k}") for k in ATTRIBUTION_KEYS]
        return idx == sorted(idx)
    check("the attribution SELECT order matches its parser's key order", attribution_alias_order_matches)
    check("the parser handles the attribution row shape",
          lambda: parse_row("1|2|3|4|5|6|7", ATTRIBUTION_KEYS)["labeled_hold_canonical"] == 7.0)

    def attribution_rejects_identity_shape() -> bool:
        # A 6-field identity row fed to the 7-field contract must RAISE, not silently short-zip.
        try:
            parse_row("1|2|3|4|5|6", ATTRIBUTION_KEYS)
        except ValueError:
            return True
        return False
    check("the parser REFUSES a wrong-width attribution row", attribution_rejects_identity_shape)

    # ── the off-host RECORD payload (R6) ──
    _rows = [
        ("emitted", "PASS", {"captured": float(ROW_CAP), "uncaptured": 0.0, "bad_sum": 0.0,
                             "bad_chain": 0.0, "max_sum_resid": 0.0, "max_chain_resid": 0.0}),
        ("hold", "INDETERMINATE", {}),
    ]
    _m = build_metrics(_rows, {k: 1.0 for k in ATTRIBUTION_KEYS}, "ok")
    # A capped number travelling off-host as if it were a total is the defect this flag prevents.
    check("a capped arm is recorded as cap_reached",
          lambda: _m["identity"]["arms"]["emitted"]["cap_reached"] is True)
    check("every arm ships its instrument beside its number",
          lambda: _m["identity"]["arms"]["emitted"]["window_days"] == WINDOW_DAYS
          and _m["identity"]["arms"]["emitted"]["row_cap"] == ROW_CAP)
    # A failed READ and a zero COUNT are different facts and must not flatten into each other.
    check("an unread arm records read_ok=false, never a zeroed count",
          lambda: _m["identity"]["arms"]["hold"]["read_ok"] is False
          and "captured" not in _m["identity"]["arms"]["hold"])
    check("the record marks the attribution figures UNCAPPED",
          lambda: _m["attribution"]["uncapped"] is True)

    _m_noattr = build_metrics(_rows, None, "RuntimeError: psql rc=2")
    check("a failed attribution read records null + a reason, and leaves identity intact",
          lambda: _m_noattr["attribution"]["counts"] is None
          and _m_noattr["attribution"]["ok"] is False
          and "psql rc=2" in _m_noattr["attribution"]["detail"]
          and _m_noattr["identity"]["arms"]["emitted"]["captured"] == ROW_CAP)

    # The RECORDER must never be able to change the gate. Its own failure path returns a reason;
    # the verdict is a pure function of the arms and nothing else touches it.
    check("the result recorder reports rather than raises",
          lambda: _append_result("fixture", "PASS", 0, {}, path="/proc/self/mem/x/y.jsonl")[0] is False)

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


def build_metrics(
    results: list[tuple[str, str, dict[str, float]]],
    attribution: dict[str, float] | None,
    attribution_detail: str,
) -> dict:
    """PURE. Assemble the off-host record's `metrics` payload.

    EVERY NUMBER CARRIES ITS INSTRUMENT. The per-arm identity figures are windowed and capped, so
    each one ships `window_days`, `row_cap` and an explicit `cap_reached` flag; the attribution
    figures are uncapped and unwindowed and live under a separate key. A reader off-host has no
    access to this file, so the record itself has to say which quantity it is holding — that is
    the whole reason a `captured=20000` at the cap must not travel as if it were a total.
    """
    arms: dict[str, dict] = {}
    for label, arm_verdict, m in results:
        if not m:
            # An empty metrics dict means the READ failed, which is a different fact from a zero
            # count. Recorded as such rather than flattened to zeros.
            arms[label] = {"verdict": arm_verdict, "read_ok": False}
            continue
        captured = int(m["captured"])
        arms[label] = {
            "verdict": arm_verdict,
            "read_ok": True,
            "captured": captured,
            "uncaptured": int(m["uncaptured"]),
            "bad_sum": int(m["bad_sum"]),
            "bad_chain": int(m["bad_chain"]),
            "max_sum_resid": m["max_sum_resid"],
            "max_chain_resid": m["max_chain_resid"],
            "window_days": WINDOW_DAYS,
            "row_cap": ROW_CAP,
            "cap_reached": captured >= ROW_CAP,
        }
    return {
        "identity": {"tolerance": TOLERANCE, "arms": arms},
        "attribution": {
            "ok": attribution is not None,
            "detail": attribution_detail,
            "barrier_spec": CANONICAL_BARRIER_SPEC,
            "uncapped": True,
            "since": "capture-start (2026-08-31T10:37:58Z); the corpus has no earlier rows",
            "counts": ({k: int(v) for k, v in attribution.items()} if attribution else None),
        },
    }


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if "--show-sql" in argv:
        for label, table, ts_col in ARMS:
            print(f"-- {label}\n{build_sql(table, ts_col, WINDOW_DAYS, ROW_CAP)}\n")
        print(f"-- attribution (uncapped, unwindowed)\n{build_attribution_sql()}\n")
        return 0

    print(f"scorer-input identity — {len(ARMS)} arms, window={WINDOW_DAYS}d, tolerance={TOLERANCE}")
    results = [(label, *check_arm(label, table, ts)) for label, table, ts in ARMS]
    verdicts = [v for _, v, _ in results]
    verdict = worst(verdicts)

    # DATA faults page; INSTRUMENT faults do not. `metrics` is empty only when the read itself
    # failed, so this distinguishes "the writer stopped" (pages) from "psql was unreachable"
    # (silent) without a second probe.
    broken = [(l, m) for l, v, m in results if v == "FAIL"]
    vacuous = [(l, m) for l, v, m in results if v == "INDETERMINATE" and m and int(m["captured"]) == 0]
    if broken or vacuous:
        lines = [f"SCORER-INPUT IDENTITY {verdict} — the captured scorer parts are not trustworthy.", ""]
        for l, m in broken:
            lines.append(
                f"  {l}: {int(m['bad_sum'])} rows fail SUM(bucket*WEIGHT)==raw0, "
                f"{int(m['bad_chain'])} fail raw0+deltas==raw_final "
                f"(max residual {m['max_sum_resid']:.3e} / {m['max_chain_resid']:.3e}, "
                f"tolerance {TOLERANCE}) over {int(m['captured'])} captured rows.")
        for l, _ in vacuous:
            lines.append(f"  {l}: ZERO captured rows in the last {WINDOW_DAYS}d — the writer has stopped.")
        lines += [
            "",
            "Capture is FORWARD-ONLY: rows written wrong, or not written at all, cannot be",
            "recovered later. Kill switch (no rebuild): SCORER_INPUT_CAPTURE_ENABLED=0.",
            "Owner: OPS-SCORER-INPUT-PERSISTENCE-W1. Successor gated on this corpus:",
            "EDGE-SELL-FEATURE-ATTRIBUTION-W{NEXT}.",
        ]
        fire("\n".join(lines))
    elif verdict == "PASS":
        clear()

    # ── THE OFF-HOST RECORD (R6) ─────────────────────────────────────────────────────────────
    #
    # Read and appended AFTER the alert decision, deliberately: the paging path must not be able
    # to wait on, or be changed by, a reporting query. The attribution read is the one thing here
    # that touches the DB again, and it never contributes to `verdict`.
    attribution, attribution_detail = read_attribution()
    if attribution is not None:
        print(
            "  attribution "
            f"labeled_emitted={int(attribution['labeled_emitted_any_spec'])} "
            f"labeled_hold={int(attribution['labeled_hold_any_spec'])} "
            f"(spec={CANONICAL_BARRIER_SPEC}: "
            f"{int(attribution['labeled_emitted_canonical'])}/"
            f"{int(attribution['labeled_hold_canonical'])})  "
            f"captured_total=(emitted {int(attribution['captured_emitted'])}, "
            f"hold {int(attribution['captured_hold'])}, "
            f"band {int(attribution['captured_band'])})  UNCAPPED"
        )
    else:
        print(f"  attribution UNAVAILABLE — {attribution_detail} (verdict unaffected)")

    ok, detail = _append_result(
        ALERT_ID, verdict, EXIT_FOR[verdict], build_metrics(results, attribution, attribution_detail)
    )
    # POSITIVE either way. A run that wrote no record must never look like one that did.
    print(f"CANARY_RESULT_LOG={'ok ' + detail if ok else 'FAILED ' + detail}")

    print(f"SCORER_IDENTITY_VERDICT={verdict}")
    return EXIT_FOR[verdict]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

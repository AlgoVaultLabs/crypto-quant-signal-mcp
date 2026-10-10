#!/usr/bin/env python3
"""
book-liveness-canary.py — OPS-PFE-METRIC-INTEGRITY-W1 R8 recurrence guard.

Watches the emit-time book-liveness gate. Three checks, each printing a POSITIVE per-check line
so a skipped check can never read like a passing one:

  1. FROZEN-ROW RATE (the defect itself).  Newly emitted signals landing in the S2 state
     (`pfe_candles = 0 AND mae_return_pct = 0` — price moved in NEITHER direction, i.e. a shut
     book) should trend toward ZERO once the gate is ENFORCING. Ceilings are MODE-AWARE: while
     the gate is in `shadow` it is not removing those rows, so the bar tolerates them; at
     `enforce` it ratchets to ~1% fleet-wide. See CEILING_NOTE below.

  2. DEAD-BOOK PERSISTENCE (the gate's blast radius, correctly typed).  Replaces the retired
     per-venue suppression RATE — see WHY_THE_RATE_WAS_RETIRED. Separates a book that is dead
     from a market that is merely CLOSED, structurally rather than by calendar. Each dead book is
     then CLASSED by the app's own admission step (DEAD_BOOK_CLASS) and only the classes an
     operator can act on page.

  3. SUPPRESSION VOLUME FLOOR (runaway-defect detector).  REPORT-ONLY until calibrated — see
     FLOOR_PROMOTION. Catches an adapter parse defect (a string/null volume read as "not
     traded") that would strangle a healthy venue, with no window dependency.

CONTRACT (CLAUDE.md ## Automation-first recovery + ## Verification gate patterns):
  - Operator-action-required only. Delegates ALL gating to send_telegram.sh — cooldown,
    severity, DRY_RUN_TG. This script MUST NOT re-implement any of them inline.
  - Prints exactly ONE terminal `BOOK_LIVENESS_VERDICT=PASS|FAIL|INDETERMINATE` line. Callers
    gate on the TOKEN, never the exit code. Codes: PASS=0 / FAIL=0 / INDETERMINATE=3.
    FAIL exits 0 because the ALERT is the action and a breach must not break a cron chain;
    3 is the token-law default for a gate with no incumbent code. Sibling precedent with the
    identical mapping: `decision-gate-orphan-canary.py`.
  - A query we were HANDED and could not run is INDETERMINATE, never a silent pass. Before
    EDGE-SELL-RESOLUTION-ENFORCE-W1 every path exited 0 with no token, so a failed `psql`
    printed "OK - 0 venue-metrics within ceilings": a dark guard indistinguishable from a
    healthy one, and the exact defect class this estate has now paid for five times.
  - `recommended_wave` uses the TEMPLATE form OPS-<CLASS>-W{NEXT}; a literal W3 is HALT-class.
    send_telegram.sh resolves it at send time from status.md.

Run `--self-test` for the hermetic two-way suite. It asserts the SQL builders and the row
parser explicitly, because those are exactly the artifacts the DB seam replaces and therefore
the only code no live scenario would otherwise execute.
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from typing import NamedTuple

# Sibling modules are installed beside this file (`/opt/algovault-monitoring/`) and live beside it in
# the repo. Put the directory on the path explicitly so a by-path load (the tests, a self-test run
# from elsewhere) resolves them the same way the cron does. Same shape as the regime canary.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

try:
    import population_rate as pr

    _RATE_IMPORT_ERROR = ""
except Exception as _e:  # noqa: BLE001 — a missing instrument is INDETERMINATE, never a crash
    pr = None  # type: ignore[assignment]
    _RATE_IMPORT_ERROR = "%s: %s" % (type(_e).__name__, _e)

try:
    from canary_result_log import MAX_LINE_BYTES as _RESULT_MAX_BYTES
    from canary_result_log import append_result as _append_result
    from canary_result_log import build_record as _build_record

    _RESULT_LOG_IMPORT_ERROR = ""
except Exception as _e:  # noqa: BLE001 — a recorder must never change the verdict
    _RESULT_LOG_IMPORT_ERROR = "%s: %s" % (type(_e).__name__, _e)
    _RESULT_MAX_BYTES = 8192
    _build_record = None  # type: ignore[assignment]

    def _append_result(*_a, **_k):  # type: ignore[misc]
        return False, "canary_result_log unavailable (%s)" % _RESULT_LOG_IMPORT_ERROR

PG_CONTAINER = "crypto-quant-signal-mcp-postgres-1"
APP_CONTAINER = "crypto-quant-signal-mcp-mcp-server-1"
PG_DB = "signal_performance"
TG = "/opt/algovault-monitoring/send_telegram.sh"

# -- ONE ALERT ID, ONE REMEDY (OPS-ALARM-SINGLE-DERIVATION-W1 CH4) ----------------------------
#
# Until this wave ONE id carried two different questions with two different remedies, and the one
# that could not clear on its own (dead books) paged on the LEVEL every cooldown. Now:
#   * ALERT_CEILING — LEVEL: the frozen-row rate + the promoted suppression floor. Calls `--clear`
#     on a run with no level breach, so its state never outlives the condition.
#   * ALERT_DEAD_BOOK — PAGE ON CHANGE, declared in DATA on its alert-registry row
#     (`page_on: "change"`, review_by 2026-12-29). This canary reports the WHOLE dead set on EVERY
#     run (ALERT_KEYS) or `--clear`s an empty one; send_telegram.sh decides what is NEW, because only
#     it knows whether a page was delivered. Keys are entity ids `dead:<VENUE>|<COIN>`.
# Distinct templated remedies: a level breach is a gate/adapter question, a NEW dead book is a
# universe-admission question (the venue switched a contract off and a declaration missed it).
ALERT_CEILING = "book_liveness_ceiling"
ALERT_DEAD_BOOK = "book_liveness_dead_book"
WAVE_CEILING = "OPS-BOOK-LIVENESS-W{NEXT}"
WAVE_DEAD_BOOK = "OPS-UNIVERSE-ADMISSION-W{NEXT}"
# A full blob URL: a bare *.md filename is not something an operator on a phone can open.
RUNBOOK_URL = ("https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/"
               "docs/RUNBOOK-BOOK-LIVENESS-FLIP.md")
RESULT_CANARY = "book-liveness"
BODY_MAX_KEYS = 40              # a Telegram message is bounded too; the full set goes to the result line
RESULT_LINE_MARGIN_BYTES = 64

# -- DEAD_BOOK_CLASS — the admission step's own verdict per dead key (OPS-ALARM-OWNER-DERIVATION-W1 CH2) --
#
# "Dead" is a fact about the EMIT GATE (suppressed on >= 24 of 28 dates); it is not, by itself, a fact
# about the venue. Until this wave every new dead book paged with a two-branch paragraph telling a human
# to go and read the venue's contract status — and 9 of 9 Aster keys that ever entered the dead set
# were venue-LIVE (R0.6, 2026-10-10: EWT KSTR USD1 NVO FUTU all `TRADING`, all thin). The gate was
# suppressing correctly; the page was not. The status those humans were sent to read is the one the
# universe admission step ALREADY reads on every fetch, so the canary now asks that step directly:
# `admission-verdict.js` runs the production `fetchVenueUniverse` (the ONE admission step, the same
# `venueStatus` path) in the app container and returns `classifyDeadBook` per key. Precedence, first
# match wins: STATUS_UNKNOWN > VENUE_OFF > ADAPTER_CONTRADICTION > THIN_LIVE (src/lib/universe-admission.ts).
#
# Paged: the three classes with an operator action. THIN_LIVE is a positive line, never a page. A
# failed verdict script makes EVERY key STATUS_UNKNOWN — noise, never silence.
DEAD_CLASSES = ("STATUS_UNKNOWN", "VENUE_OFF", "ADAPTER_CONTRADICTION", "THIN_LIVE")   # precedence order
PAGED_CLASSES = frozenset(("STATUS_UNKNOWN", "VENUE_OFF", "ADAPTER_CONTRADICTION"))
# One remedy per class. ADAPTER_CONTRADICTION is the gate/adapter question, so it shares the LEVEL
# remedy's template; the other two are admission questions.
CLASS_REMEDY = {"STATUS_UNKNOWN": WAVE_DEAD_BOOK, "VENUE_OFF": WAVE_DEAD_BOOK, "ADAPTER_CONTRADICTION": WAVE_CEILING}
ADMISSION_CMD = ["docker", "exec", APP_CONTAINER, "node", "dist/scripts/admission-verdict.js", "--keys"]
ADMISSION_TOKEN = "ADMISSION_VERDICT_EMIT"
ADMISSION_TIMEOUT_S = 240      # one universe fetch per venue + one 24-bar read per key, batch class
THIN_LIVE_LINE = ("DEAD_BOOKS_THIN_LIVE=%d (not paged: the venue lists them tradeable; the emit gate is "
                  "suppressing correctly)")
REASON_MAX_CHARS = 140         # per-key reason in the page body; the full reason is in the run log

VERDICT_TOKEN = "BOOK_LIVENESS_VERDICT"
EXIT_INDETERMINATE = 3

LOOKBACK_DAYS = 3
MIN_DENOM = 200   # below this a percentage is noise, not a signal

# -- WHY_THE_RATE_WAS_RETIRED ---------------------------------------------------------------
#
# `SUPPRESSION_CEILING_PCT` (ASTER 40.0 / _DEFAULT 5.0) is GONE, and this is a CORRECTNESS fix,
# not a silencing. It computed `suppressed / (suppressed + emitted)`, dividing a numerator from
# `emit_suppressions` by a denominator from `signals`. Those count DIFFERENT populations:
#
#   * `emit_suppressions` increments on EVERY non-internal directional decision on a frozen book
#     - seed crons AND live `get_trade_call` invocations.
#   * `signals` holds only PERSISTED rows: seed writes, gated by `hasRecentSignalAsync` dedup.
#     A live tool call never writes there.
#
# Measured 2026-08-28 on prod-204: 29 `(venue, coin, timeframe)` cells carried suppressions with
# ZERO in-window signal rows (e.g. `ASTER|SAND|15m` sup=2 emi=0 - that pair's last signal
# predates the shadow window). So the percentage was a confident number for a quantity nobody
# defined: the `@{upstream}` defect in a new substrate. It is replaced by two well-defined
# checks below, neither of which needs that denominator.
#
# The rate was ALSO mode-dependent: in `shadow` a would-be-suppressed call is still emitted, so
# `suppressed + emitted` double-counts; in `enforce` it does not. That is the concrete content of
# the inventory row's "both checks presuppose the gate is ENFORCING".
#
# REFUTED ALTERNATIVE - do not re-propose without re-measuring. A recovery-based discriminator
# ("a dead book never emits; a closed market emits when it reopens") is the obvious improvement
# and was TESTED on 2026-08-28. It DOES NOT WORK IN SHADOW: 30 of 34 suppressed `(venue, coin)`
# pairs read NO-RECOVERY, including 25 plainly closed-market equity pairs, because the recovery
# signal is read from the same deduped `signals` denominator described above. It may become
# evaluable once the gate is enforcing; it is not evaluable now.

# -- CEILING_NOTE - frozen-row ceilings are MODE-AWARE ---------------------------------------
#
# The SHADOW table tolerates the defect the gate exists to remove, because in shadow the gate is
# NOT removing it. The ENFORCE table is the real bar: once emissions stop landing in frozen books
# the S2 population should collapse. Leaving the shadow numbers in place at enforce would mean
# the canary silently tolerates a fully regressed gate - a defensive threshold outliving its own
# reason. Mode-keying discharges that ratchet STRUCTURALLY instead of leaving it as a runbook
# checklist item nobody re-reads.
#
# Measured per-venue frozen rate on evaluated rows, 3d window, prod-204, 2026-08-28T16:16Z:
#   XT 3.694% (14/379) - HTX 2.510% (6/239) - ASTER 0.682% (3/440) - GATE 0.076% (2/2634)
#   every other emitting venue: EXACTLY 0.000%
# For contrast, the 2026-07-21 baselines this replaces read ASTER 8.35% / HTX 4.98% / XT 0.15%.
# XT's shadow ceiling is DELIBERATELY above its old 2.0 pin: the frozen population MIGRATED onto
# XT (`XT|D`, `XT|EPT`) and HTX, and pinning shadow below the migrated reality would page every
# night on a condition only ENFORCE can fix. The enforce ceiling is where the bar actually bites.
#
# TODO: revisit by 2026-09-11 - re-derive both tables from >=14d of live data spanning >=2
# weekends, and record the revision in `Claude files/defensive-reductions-to-revisit.md`.
FROZEN_CEILING_PCT_SHADOW = {
    "XT": 6.0,       # measured 3.694%
    "HTX": 5.0,      # measured 2.510%
    "EDGEX": 4.0,    # 1.94% all-time; no rows in the live 3d window. Entry KEPT so the guard is
                     # not silently dropped if EDGEX resumes emitting.
    "ASTER": 3.0,    # measured 0.682% - down from the 8.35% that motivated the old 12.0 pin
    "_DEFAULT": 1.0, # 12 of 16 emitting venues sit at exactly 0.000%
}
FROZEN_CEILING_PCT_ENFORCE = {
    "_DEFAULT": 1.0, # the ratchet: with the gate enforcing, NO venue should keep minting S2 rows
}

# -- DEAD_BOOK - the closed-vs-broken discriminator (EDGE-SELL-RESOLUTION-ENFORCE-W1 CH2) ----
#
# A dead book is suppressed on nearly EVERY day in the window; a closed market recovers when its
# session reopens. So the discriminator is PERSISTENCE IN DAYS, and it needs no market-hours
# calendar, no venue name and no asset-class classifier - the same deliberate ignorance the
# predicate itself keeps.
#
# WHY N=24 OF D=28, and why nothing smaller is safe (architect rider, 2026-08-28):
# the window must exceed the longest LEGITIMATE closure plus the ordinary weekend days inside
# it, or a holiday closure is misread as a dead book and the canary pages on correct behaviour.
# The binding case is not a US holiday weekend: `GATE`'s suppressed books are Chinese A-share
# tickers (BIWIN NAURA HUAGONGTECH PUYA XIECHUANG YONGDING) and `ASTER` carries US equities, so
# the worst legitimate case is a multi-day exchange holiday landing on top of the ~8 weekend days
# inside a 28-day window. N=24 leaves margin on both sides: a dead book scores 28/28, while the
# worst legitimate closure stays well below 24.
#
# Measured separation, prod-204 2026-08-28 (4 days of counter data - the SHAPE, not yet the pin):
#   dead:   XT|EPT 4 days x 3 timeframes - XT|D 4 x 3 - HTX|{LRDS,SEI,VIRTUAL} 2 x 2
#   closed: 29 (venue, coin) pairs on ASTER + GATE, all at exactly 1 day
#
# HONEST LIMIT: with D=28 this check CANNOT fire until the counter is 28 days old. Until then it
# reports INSUFFICIENT_WINDOW as a positive line CARRYING ITS OWN END DATE, projected from the
# counter's first row - the corpus was handed to us and is genuinely short, which is a FACT to
# report, not vacuity to refuse. No date is hardcoded here on purpose: a constant in a comment
# goes stale silently, and this one already did once (it read "~2026-09-22", derived from the
# reason-scoped window that the shadow->enforce flip reset; the real date is earlier because the
# window is now seeded from the counter's real first row, 2026-08-25).
#
# The gap is TOTAL while it lasts, and that is why the output says so: under enforce a dead book
# emits nothing, so it mints no frozen rows, so check 1 cannot see it either. There is no partial
# coverage to fall back on.
#
# TODO: revisit by 2026-09-11 - confirm the longest legitimate closure against a real
# exchange-holiday source and raise D if it exceeds the budget; record in
# `Claude files/defensive-reductions-to-revisit.md`.
DEAD_BOOK_WINDOW_DAYS = 28
DEAD_BOOK_MIN_DAYS = 24

# -- FLOOR_PROMOTION - REPORT-ONLY, deliberately ---------------------------------------------
#
# A per-(venue, day) suppression COUNT catches a runaway adapter parse defect immediately, with
# no window dependency - the one thing the retired rate ceiling was genuinely good for.
#
# It ships REPORT-ONLY because it CANNOT YET BE CALIBRATED: the shadow window so far is
# 2026-08-25 (Tue) -> 2026-08-28 (Fri) and contains NO WEEKEND, while the closed-market
# population is exactly the one that peaks at a weekend. Observed weekday maxima per venue-day
# are ASTER 10 - XT 10 - HTX 9 - GATE 5. Pinning from a weekday-only maximum would page on the
# first Saturday: the precise failure this wave exists to avoid.
#
# PROMOTION CRITERION (numeric AND time-bounded, so it cannot sit in REPORT forever):
#   >=14 days of counter data spanning >=2 weekends, then pin at 3x the observed per-venue
#   maximum and promote to paging in `OPS-BOOK-LIVENESS-W{NEXT}`. Earliest 2026-09-08.
# Every run appends its observed maximum to the log, so the healing RATE is measured at the
# decision rather than guessed.
FLOOR_REPORT_ONLY = False
FLOOR_PROMOTION_EARLIEST = "2026-09-08"
# PROMOTED (OPS-ALARM-SINGLE-DERIVATION-W1 CH4) — the criterion above was met: the counter has run
# since 2026-08-25, and the exact 28-date window 2026-09-03..2026-09-30 holds 8 weekend dates.
# Measured maxima per (venue, UTC day) over that window, read 2026-09-30T06:15Z (thin R0.5):
FLOOR_MEASURED_AT = "2026-09-30"
FLOOR_MEASURED_MAX = {"ASTER": 1060, "GATE": 472, "HTX": 96, "XT": 93, "BYBIT": 9, "MEXC": 6,
                      "BINGX": 3, "HL": 2, "BITGET": 1}
FLOOR_PIN_MULTIPLE = 3
FLOOR_PINS = {venue: FLOOR_PIN_MULTIPLE * peak for venue, peak in FLOOR_MEASURED_MAX.items()}
# A venue with NO observed maximum (BINANCE, OKX, KUCOIN, PHEMEX, WHITEBIT, WEEX at promotion) has
# no "3 x observed max": it stays report-only, rather than a pin of 0 that would page on its first
# suppression. The XT/HTX maxima include books the universe admission step has since removed, so
# their pins are loose — loose is the safe side for a runaway-defect detector.
# TODO: revisit by 2026-10-28 — re-measure once the window is entirely post-admission (from
# 2026-10-28) and record the revision in `Claude files/defensive-reductions-to-revisit.md`.


# == pure builders + parser - extracted so `--self-test` can assert the artifacts the DB seam
#    replaces. A hermetic suite is otherwise structurally blind to exactly these. ==

def _safe_literal(value):
    """Refuse anything that is not a bare token. These interpolate into SQL; the values are ours
    (a SuppressionReason union), but a builder that CAN be handed a quote should refuse it here
    rather than rely on every future caller being careful."""
    v = str(value)
    if not v or not all(c.isalnum() or c == "_" for c in v):
        raise ValueError("unsafe SQL literal: %r" % (value,))
    return v


def build_frozen_sql(lookback_days):
    """Per-venue frozen-row (S2) counts over the lookback window."""
    return (
        "SELECT exchange,"
        " COUNT(*) FILTER (WHERE pfe_candles IS NOT NULL) AS n_eval,"
        " COUNT(*) FILTER (WHERE pfe_candles = 0 AND mae_return_pct = 0) AS n_frozen"
        " FROM signals"
        " WHERE signal IN ('BUY','SELL')"
        "   AND created_at >= EXTRACT(EPOCH FROM NOW())::bigint - %d*86400"
        " GROUP BY 1 ORDER BY 1;" % int(lookback_days)
    )


class WindowBounds(NamedTuple):
    """The ONE window derivation (OPS-ALARM-SINGLE-DERIVATION-W1 CH4).

    `date >= (NOW() - INTERVAL 'D days')::date` spans D+1 calendar dates — measured: 29 distinct
    dates against a stated 28, which is where "suppressed on 29 of the last 28 days" came from.
    The persistence SQL, the floor SQL, the N-of-D text and `window_complete_note` all read THIS,
    so the window is derived once and every consumer projects from it.
    """
    days: int        # exactly this many dates
    lo_offset: int   # CURRENT_DATE - lo_offset is the first date
    sql: str         # the predicate every window query carries

    def dates(self, today):
        return today - timedelta(days=self.lo_offset), today


def window_bounds(days):
    """[CURRENT_DATE - (D-1), CURRENT_DATE] — EXACTLY D dates. Pure."""
    d = int(days)
    if d < 1:
        raise ValueError("a window holds at least one date, got %r" % (days,))
    return WindowBounds(d, d - 1, "date >= CURRENT_DATE - %d AND date <= CURRENT_DATE" % (d - 1))


def build_persistence_sql(window_days):
    """Distinct days each (venue, coin) was suppressed, plus its timeframe breadth.

    -- REASON-INDEPENDENT BY DESIGN. Do not re-scope this to a rollout stage. --
    #
    # This asks ONE physical question: on how many days was this (venue, coin) book frozen?
    # `emit_suppressions` answers it identically in both stages - `frozen_book` means "we
    # withheld", `frozen_book_shadow` means "we would have", and BOTH are the same observation
    # of the same book on the same day. The reason column records WHO ASKED, never WHAT WAS
    # TRUE, and scoping this query by it conflated the two.
    #
    # MEASURED COST of the version that did scope it (2026-08-29, EDGE-SELL-RESOLUTION-ENFORCE-W1
    # CH3): the shadow->enforce flip changed `reason_for(mode)`, both this query and the
    # counter-age query lost their entire history in one instant, and the detector's window
    # restarted from zero. Counter age went 5 days -> 1. Three of the five KNOWN dead books
    # (`XT|D`, `HTX|LRDS`, `HTX|VIRTUAL`) dropped to ZERO recorded days. Nothing errored and
    # nothing alerted; the detector simply went quiet for 28 days.
    #
    # A window keyed on a MUTABLE value restarts itself every time that value changes - and a
    # flag flip, a re-key or a new reason string are all ordinary events. The fix is not to
    # remember to re-seed after a flip; it is to stop keying the window on something that moves.
    """
    wb = window_bounds(window_days)
    return (
        "SELECT exchange, coin,"
        " COUNT(DISTINCT date) AS days,"
        " COUNT(DISTINCT timeframe) AS tfs,"
        " SUM(suppress_count)::bigint AS n,"
        " (SELECT COUNT(DISTINCT date) FROM emit_suppressions"
        "   WHERE %s) AS window_days_seen"
        " FROM emit_suppressions"
        " WHERE %s"
        " GROUP BY 1,2 ORDER BY 3 DESC, 5 DESC;" % (wb.sql, wb.sql)
    )


def build_counter_age_sql():
    """How many distinct days the counter has EXISTED for, unbounded by the window.

    Its own query rather than a subquery on the grouped result, because the grouped result is
    empty in exactly the state that matters - a fully enforcing gate with nothing left to
    suppress - and a value read off row[0] of an empty set is not a value.

    REASON-INDEPENDENT for the reason given on `build_persistence_sql`: the counter's AGE is a
    property of the counter, not of whichever stage happens to be writing to it today.
    """
    return (
        "SELECT COALESCE(MAX(date) - MIN(date), 0) + CASE WHEN COUNT(*) = 0 THEN 0 ELSE 1 END,"
        " COALESCE(MIN(date)::text, '')"
        " FROM emit_suppressions;"
    )


def build_shadow_recency_sql():
    """Whole days since the SHADOW stage last wrote a suppression. 99999 when it never did.

    This is how the canary knows whether its frozen-row window is still carrying rows from the
    PREVIOUS rollout stage — see MIXED_WINDOW below.
    """
    return (
        "SELECT COALESCE((NOW()::date - MAX(date)), 99999)"
        " FROM emit_suppressions WHERE reason = 'frozen_book_shadow';"
    )


def frozen_table_for(mode, shadow_age_days, lookback_days):
    """(table, label) - which frozen-row ceiling applies RIGHT NOW.

    -- MIXED_WINDOW: why the enforce ratchet cannot bite the instant the flag flips --
    #
    # The frozen-row check reads a LOOKBACK_DAYS window of already-emitted rows. The mode flag
    # flips in one instant; that window does not. For LOOKBACK_DAYS after a shadow->enforce
    # flip the window is still full of rows the gate was NOT YET SUPPRESSING, and judging them
    # against the enforce ratchet pages on a regression that never happened.
    #
    # MEASURED at the real flip, 2026-08-29T03:25:45Z: the enforce table breached HTX 2.36%
    # and XT 2.85% within seconds, and ALL 21 offending rows (ASTER 3, GATE 2, HTX 6, XT 10)
    # were emitted BEFORE the flip - post-flip count was 0 on every venue. A guard that fires
    # on its own cutover teaches the operator to ignore it, which is the failure mode this
    # whole wave exists to retire.
    #
    # So the ratchet engages only once the window is ENTIRELY post-transition, detected from
    # the DATA rather than from a stamp the canary would have to keep: `frozen_book_shadow`
    # rows carry the last day the previous stage was writing. No new state, self-correcting,
    # and it handles a flip BACK to shadow for free.
    """
    if mode != "enforce":
        return FROZEN_CEILING_PCT_SHADOW, "shadow"
    if shadow_age_days < lookback_days:
        return FROZEN_CEILING_PCT_SHADOW, "shadow (MIXED_WINDOW)"
    return FROZEN_CEILING_PCT_ENFORCE, "enforce"


def build_floor_sql(window_days):
    """Maximum suppressions recorded for any single (venue, day) in the window.

    REASON-INDEPENDENT, same reasoning: a runaway adapter parse defect is a runaway defect in
    either stage, and stage-scoping this reset the observed maxima at the flip too (measured
    2026-08-29: ASTER 18 / XT 12 / HTX 9 / GATE 5 collapsed to XT 4 / HTX 1).
    """
    return (
        "SELECT exchange, MAX(d), (array_agg(date ORDER BY d DESC))[1] FROM ("
        "  SELECT exchange, date, SUM(suppress_count) AS d FROM emit_suppressions"
        "   WHERE %s"
        "   GROUP BY 1,2) t"
        " GROUP BY 1 ORDER BY 2 DESC;" % window_bounds(window_days).sql
    )


def parse_rows(raw, min_fields):
    """Split `psql -tA -F'|'` output into field lists, dropping short and blank rows.

    Kept pure and separate because the live parser is the other artifact the DB seam bypasses -
    the sibling `quota-exhaustion-canary.py` shipped two live-only defects in exactly this shape.
    """
    out = []
    for line in (raw or "").split("\n"):
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) >= min_fields:
            out.append(parts)
    return out


def window_complete_note(min_date_iso, window_days):
    """"full coverage on <date>" - the day the trailing window is first complete.

    Derived from the counter's OWN first row rather than from a wave-authored constant, so it
    stays correct if the counter is ever reseeded and cannot rot into a stale promise.
    """
    try:
        d0 = datetime.strptime(min_date_iso, "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return "no suppressions recorded yet, so the window has not started"
    return "full coverage on %s" % (d0 + timedelta(days=window_bounds(window_days).lo_offset)).isoformat()


def ceiling(table, venue):
    return table.get(venue, table["_DEFAULT"])


def resolve_mode(enabled_raw, mode_raw):
    """Mirror of the SHIPPED resolver in `src/lib/book-liveness.ts` - kill switch dominates the
    mode, and enabled-with-garbage-mode resolves to `shadow`, never `enforce`."""
    enabled = str(enabled_raw or "").strip().lower()
    if enabled not in ("1", "true"):
        return "off"
    mode = str(mode_raw or "").strip().lower()
    if mode == "enforce":
        return "enforce"
    if mode == "shadow":
        return "shadow"
    return "shadow"


def reason_for(mode):
    """The ONE mapping from rollout stage to recorded reason. Mirrors `suppressionReasonFor` in
    `src/lib/emit-suppressions.ts`; `off` can never reach the writer, so it maps to the shadow
    value rather than inventing a third."""
    return "frozen_book" if mode == "enforce" else "frozen_book_shadow"


def classify_persistence(rows, min_days, window_days, days_seen, counter_age_days):
    """(dead_books, evaluable) - a (venue, coin) suppressed on >= min_days distinct days.

    `evaluable` is False while the COUNTER ITSELF is younger than `window_days`: the threshold is
    only meaningful against a full window, and reporting a verdict from a short one would mistake
    a young counter for a healthy fleet.

    `counter_age_days` and `days_seen` are DIFFERENT questions and conflating them is a reporting
    lie in the state this canary is built to reach. `days_seen` counts days that CARRY a
    suppression; `counter_age_days` counts days the counter has existed. Once the gate is
    enforcing well, `days_seen` legitimately falls to 0 — and a guard that then reports
    "INSUFFICIENT_WINDOW" would be calling its own success an unknown. Zero suppressions over a
    FULL window is a fact we were handed: it is a reported PASS, not an inability to judge.
    """
    if counter_age_days < window_days:
        return [], False
    # ONE bound for every row (OPS-ALARM-SINGLE-DERIVATION-W1 CH4): a (venue, coin) can never carry
    # more distinct dates than its window holds. pr.bounded_fraction RAISES InstrumentDefect on
    # "29 of 28", so a builder that regresses to the interval form is INDETERMINATE, never a page.
    pr.bounded_fraction(int(days_seen or 0), window_days, "window dates")
    dead = []
    for r in rows:
        venue, coin, days, tfs = r[0], r[1], int(r[2] or 0), int(r[3] or 0)
        n_of_d = pr.bounded_fraction(days, window_days, "days")
        if days >= min_days:
            dead.append(DeadBook(venue, coin, days, tfs, n_of_d))
    return dead, True


class DeadBook(NamedTuple):
    venue: str
    coin: str
    days: int
    tfs: int
    n_of_d: str      # "26 of 28 days" — ALWAYS rendered through pr.bounded_fraction

    @property
    def key(self):
        """The page-on-change key: an ENTITY id, never a figure that changes nightly."""
        return dead_key(self.venue, self.coin)

    @property
    def line(self):
        return "%s|%s: suppressed on %s across %d timeframe(s)" % (self.venue, self.coin, self.n_of_d,
                                                                   self.tfs)


def dead_key(venue, coin):
    return "dead:%s|%s" % (venue, coin)


def classify_floor(rows, pins=None):
    """(breaches, info) for the PROMOTED floor. Pure.

    `rows` are `exchange|max_day[|date_of_max]`. A venue with a pin breaches when its busiest day
    in the window exceeds the pin; a venue with no observed maximum at promotion has no pin and is
    reported, never paged.
    """
    pins = FLOOR_PINS if pins is None else pins
    breaches, info = [], []
    for r in rows:
        venue, peak = r[0], int(r[1] or 0)
        when = (" on %s" % r[2]) if len(r) > 2 and r[2] else ""
        pin = pins.get(venue)
        if pin is None:
            info.append("floor %s: %d suppressions%s — no pin (no observed maximum at promotion), "
                        "report-only" % (venue, peak, when))
        elif peak > pin:
            breaches.append("floor %s: %d suppressions%s > pin %d (%d x the %d measured %s)"
                            % (venue, peak, when, pin, FLOOR_PIN_MULTIPLE,
                               FLOOR_MEASURED_MAX.get(venue, 0), FLOOR_MEASURED_AT))
        else:
            info.append("floor %s: %d%s within pin %d" % (venue, peak, when, pin))
    return breaches, info


def build_ceiling_body(breaches, mode, stamp, lo, hi):
    """The LEVEL alert's body: the breached measurements and nothing the run did not measure."""
    return "\n".join([
        "\U0001F9CA Book-liveness canary: LEVEL breach (frozen-row rate or suppression floor)",
        "",
        "Window: frozen %dd · floor %d dates %s..%s (UTC) · gate mode %s · checked %s"
        % (LOOKBACK_DAYS, DEAD_BOOK_WINDOW_DAYS, lo, hi, mode, stamp),
        "",
        "BREACHED:",
        *["  - %s" % b for b in breaches],
        "",
        "  - frozen-rate up  -> the emit gate regressed, its pin drifted, or a NEW venue started",
        "                      serving zero-volume synthetic bars.",
        "  - floor breached  -> one venue suppressed more on one day than %d x its measured"
        % FLOOR_PIN_MULTIPLE,
        "                      maximum: the runaway-parse-defect case (live volume read as zero).",
        "",
        "Rollback is one env key (behaviour returns to legacy, byte-identical):",
        "  EMIT_BOOK_LIVENESS_ENABLED=0 && docker compose up -d mcp-server",
        "",
        "Runbook: %s" % RUNBOOK_URL,
        "recommended_wave: %s" % WAVE_CEILING,
    ])


class AdmissionError(Exception):
    """The admission verdict could not be obtained or parsed. Every dead key is then STATUS_UNKNOWN."""


def parse_admission_output(stdout, keys):
    """{key: verdict} from `admission-verdict.js` stdout. PURE. Raises AdmissionError unless the run
    ended `ADMISSION_VERDICT_EMIT=PASS` with ONE JSON object classing EXACTLY the requested keys in the
    four-class vocabulary. Log lines the app prints first (`[universe-admission] …`) are skipped."""
    lines = (stdout or "").splitlines()
    tok = [i for i, ln in enumerate(lines) if ln.startswith(ADMISSION_TOKEN + "=")]
    if not tok:
        raise AdmissionError("no %s token in the script output" % ADMISSION_TOKEN)
    last = tok[-1]
    if lines[last] != ADMISSION_TOKEN + "=PASS":
        raise AdmissionError("the script said %s" % lines[last])
    blob = next((ln for ln in reversed(lines[:last]) if ln.startswith("{")), None)
    if blob is None:
        raise AdmissionError("no JSON line before %s=PASS" % ADMISSION_TOKEN)
    try:
        doc = json.loads(blob)
    except ValueError as e:
        raise AdmissionError("unparseable JSON line: %s" % e)
    rows = doc.get("keys") if isinstance(doc, dict) else None
    if not isinstance(rows, list):
        raise AdmissionError("the JSON line carries no keys list")
    out = {}
    for r in rows:
        if not isinstance(r, dict) or r.get("class") not in DEAD_CLASSES or not isinstance(r.get("key"), str):
            raise AdmissionError("a row outside the contract: %r" % (r,))
        if r["key"] in out:
            raise AdmissionError("key %s classed twice" % r["key"])
        out[r["key"]] = r
    if sorted(out) != sorted(keys):
        raise AdmissionError("classed keys %s != requested %s" % (sorted(out), sorted(keys)))
    return out


def admission_verdicts(keys):
    """The app's own admission verdict per dead key — the live seam (stubbed in tests). Read-only:
    the script opens no database and writes nothing. Raises AdmissionError on any failure."""
    try:
        r = subprocess.run(ADMISSION_CMD + [" ".join(keys)], capture_output=True, text=True,
                           timeout=ADMISSION_TIMEOUT_S, check=False)
    except Exception as e:  # noqa: BLE001 — an unreachable container is a verdict we could not get
        raise AdmissionError("could not run the admission verdict: %s" % e)
    return parse_admission_output(r.stdout, keys)


def classify_dead_set(dead, verdicts, failure=None):
    """(classes, paged, thin). PURE. `classes` maps EVERY dead key to its verdict; `paged` and `thin`
    keep the dead set's order. `verdicts` None (the script failed) ⇒ every key STATUS_UNKNOWN."""
    classes = {}
    for d in dead:
        v = (verdicts or {}).get(d.key)
        if v is None:
            v = {"key": d.key, "class": "STATUS_UNKNOWN",
                 "reason": "admission verdict unavailable: %s" % (failure or "no verdict for this key")}
        classes[d.key] = v
    paged = [d for d in dead if classes[d.key]["class"] in PAGED_CLASSES]
    thin = [d for d in dead if classes[d.key]["class"] == "THIN_LIVE"]
    return classes, paged, thin


def dead_book_dispatch(evaluable, paged):
    """What the dead-book id hears this run: ("fire", keys) · ("clear", None) · (None, None) when the
    window could not be judged — "could not judge" is not "nothing is dead". PURE."""
    if not evaluable:
        return None, None
    if paged:
        return "fire", [d.key for d in paged]
    return "clear", None


def _class_detail(v):
    """status · last trade · traded bars 24h · reason — what a reader needs to act on one key."""
    def val(x):
        return "n/a" if x is None else x
    reason = str(v.get("reason") or "")
    if len(reason) > REASON_MAX_CHARS:
        reason = reason[:REASON_MAX_CHARS - 1] + "…"
    return "status %s · last trade %s · traded bars 24h %s · %s" % (
        val(v.get("status_state")), val(v.get("venue_last_trade")), val(v.get("traded_bars_24h")), reason)


def build_dead_body(paged, thin, classes, mode, stamp, lo, hi):
    """The page-on-change body: each PAGED dead book with its class, the venue's status, its last
    trade and its traded bars, then ONE remedy per class present. The wrapper prepends the derived
    `NEW: … · still present (acknowledged): n` header, so NEW is never guessed here."""
    shown = paged[:BODY_MAX_KEYS]
    lines = [
        "\U0001F9CA Book-liveness canary: dead book(s) the venue's own status does not explain — this "
        "alert pages on ENTRY; the header names what is NEW",
        "",
        "Window: exactly %d dates %s..%s (UTC) · dead = suppressed on >= %d of them · gate mode %s · "
        "checked %s" % (DEAD_BOOK_WINDOW_DAYS, lo, hi, DEAD_BOOK_MIN_DAYS, mode, stamp),
        "",
        "Paged dead books: %d · not paged (THIN_LIVE): %d" % (len(paged), len(thin)),
        *["  - %s — suppressed on %s across %d timeframe(s) — %s: %s"
          % (d.key, d.n_of_d, d.tfs, classes[d.key]["class"], _class_detail(classes[d.key])) for d in shown],
    ]
    if len(paged) > len(shown):
        lines.append("  … and %d more book(s) — the full key set is in canary-results.jsonl"
                     % (len(paged) - len(shown)))
    present = [c for c in DEAD_CLASSES if c in PAGED_CLASSES
               and any(classes[d.key]["class"] == c for d in paged)]
    unknown_venues = sorted({d.venue for d in paged if classes[d.key]["class"] == "STATUS_UNKNOWN"})
    meaning = {
        "VENUE_OFF": "the venue's own status switches the contract off (or no longer lists it) and it "
                     "still reached the gate: fix the venue's admission declaration",
        "ADAPTER_CONTRADICTION": "the venue's ticker says it traded inside the window and the adapter's "
                                 "bars show nothing: the adapter is blind to a live market",
        "STATUS_UNKNOWN": "admission could not read a trustworthy status: declare a status source for %s"
                          % ", ".join(unknown_venues),
    }
    lines += ["", "Remedy by class:"]
    lines += ["  %s — %s -> %s" % (c, meaning[c], CLASS_REMEDY[c]) for c in present]
    lines += [
        "",
        THIN_LIVE_LINE % len(thin),
        "",
        "Runbook: %s" % RUNBOOK_URL,
    ]
    for w in sorted({CLASS_REMEDY[c] for c in present}, key=[CLASS_REMEDY[c] for c in present].index):
        lines.append("recommended_wave: %s" % w)
    return "\n".join(lines)


def bound_keys(keys, render, cap_bytes):
    """(kept, dropped) — the longest prefix of `keys` whose rendered result line fits `cap_bytes`.
    Pure. The keys are what make the close condition machine-checkable, so they are kept whole
    wherever they fit, and a truncation is RECORDED, never silent."""
    kept = list(keys)
    while kept and len(render(kept).encode("utf-8")) > cap_bytes:
        kept.pop()
    return kept, len(keys) - len(kept)


def build_result_metrics(verdict, exit_code, mode, lo, hi, dead, floor_rows, level_breaches,
                         evaluable, counter_age, dead_class=None):
    """The structured result line. Counts plus the dead-set KEYS, bounded to the recorder's cap.

    `dead_keys` keeps its meaning — the FULL dead set (OPS-ALARM-SINGLE-DERIVATION-W1's CLOSE_WHEN
    reads it). `dead_key_class` (key -> class) and `paged_keys` (the subset sent as ALERT_KEYS) ride
    beside it, bounded by the SAME kept prefix so the three never disagree about which keys exist."""
    dead_class = dead_class or {}
    per_venue = {}
    for d in dead:
        per_venue[d.venue] = per_venue.get(d.venue, 0) + 1
    base = {
        "mode": mode,
        "window": {"dates": DEAD_BOOK_WINDOW_DAYS, "from": lo, "to": hi},
        "evaluable": evaluable,
        "counter_age_days": counter_age,
        "dead_set_size": len(dead),
        "dead_per_venue": per_venue,
        "floor_max": {r[0]: int(r[1] or 0) for r in floor_rows},
        "level_breaches": len(level_breaches),
    }

    def classed(keys):
        return {
            "dead_key_class": {k: dead_class[k] for k in keys if k in dead_class},
            "paged_keys": [k for k in keys if dead_class.get(k) in PAGED_CLASSES],
        }

    def render(keys):
        m = dict(base, dead_keys=keys, dead_keys_dropped=len(dead) - len(keys), **classed(keys))
        if _build_record is not None:
            return _build_record(RESULT_CANARY, verdict, exit_code, m, at="2026-01-01T00:00:00Z")
        return json.dumps(m, separators=(",", ":"))

    kept, dropped = bound_keys([d.key for d in dead], render,
                               _RESULT_MAX_BYTES - RESULT_LINE_MARGIN_BYTES)
    return dict(base, dead_keys=kept, dead_keys_dropped=dropped, **classed(kept))


# == live plumbing ==

class QueryError(Exception):
    """A query we were HANDED and could not run. INDETERMINATE, never a pass."""


def pg_user():
    """Read the role from the container rather than hardcoding it - the app role has been
    renamed once already, and a wrong -U is an INDETERMINATE we would rather not manufacture."""
    try:
        out = subprocess.run(["docker", "exec", PG_CONTAINER, "printenv", "POSTGRES_USER"],
                             capture_output=True, text=True, timeout=20,
                             check=True).stdout.strip()
        return out or "algovault"
    except Exception:  # noqa: BLE001
        return "algovault"


def psql(sql):
    """Read-only query via `psql -tA`. Raises QueryError - the caller decides the verdict.

    The pre-EDGE-SELL-RESOLUTION-ENFORCE-W1 version returned [] here, which made an unreachable
    database indistinguishable from a clean fleet at exit 0.
    """
    try:
        return subprocess.run(
            ["docker", "exec", PG_CONTAINER, "psql", "-U", pg_user(), "-d", PG_DB,
             "-tA", "-F", "|", "-c", sql],
            capture_output=True, text=True, timeout=60, check=True,
        ).stdout.strip()
    except Exception as e:  # noqa: BLE001
        raise QueryError(str(e))


def probe_mode():
    """Resolve the live rollout stage from the app container. Raises QueryError if unreadable -
    every check below is mode-scoped, so an unknown mode is INDETERMINATE, not a default."""
    try:
        raw = subprocess.run(["docker", "exec", APP_CONTAINER, "env"],
                             capture_output=True, text=True, timeout=20, check=True).stdout
    except Exception as e:  # noqa: BLE001
        raise QueryError("cannot read %s env: %s" % (APP_CONTAINER, e))
    env = {}
    for line in raw.split("\n"):
        if "=" in line:
            k, _, v = line.partition("=")
            env[k] = v
    return resolve_mode(env.get("EMIT_BOOK_LIVENESS_ENABLED"),
                        env.get("EMIT_BOOK_LIVENESS_MODE"))


def _token_exit_map():
    """The token vocabulary and its exit codes, as DATA.

    Exists so a caller — and `tests/unit/book-liveness-canary.test.ts` — can assert the mapping
    against the SHIPPED source instead of against a copy that drifts. PASS/FAIL both exit 0
    because the ALERT is the action; INDETERMINATE is 3, the token-law default for a new gate.
    """
    return {"PASS": 0, "FAIL": 0, "INDETERMINATE": EXIT_INDETERMINATE}


def _dispatch(argv, body=None, keys=None):
    """Run the shared wrapper. Fail-open: a dispatch failure is printed and never changes a verdict.
    `keys` travel as ALERT_KEYS — the wrapper's page-on-change input, honoured only for a registry
    row that opted in."""
    env = dict(os.environ)
    if keys is not None:
        env["ALERT_KEYS"] = " ".join(keys)
    try:
        subprocess.run(argv, input=body, text=True, timeout=30, check=False, env=env)
    except Exception as e:  # noqa: BLE001
        print("[book-liveness-canary] TG dispatch failed (fail-open): %s" % e, file=sys.stderr)


# The four call sites stay LITERAL: check-alert-registry.mjs enumerates alert ids by their position
# in a `[TG, "<id>", "CRITICAL_PERSISTENT"` call, and a parameterised id would hide both from it.
# Each is its own stubbable seam, so a test can drive the real `main()` without touching the wrapper.
def fire_ceiling(body):
    _dispatch([TG, "book_liveness_ceiling", "CRITICAL_PERSISTENT", "-"], body)


def clear_ceiling():
    _dispatch([TG, "--clear", "book_liveness_ceiling"])


def fire_dead_book(body, keys):
    _dispatch([TG, "book_liveness_dead_book", "CRITICAL_PERSISTENT", "-"], body, keys)


def clear_dead_book():
    _dispatch([TG, "--clear", "book_liveness_dead_book"])


def record_result(verdict, exit_code, metrics):
    """One structured line per run (canary_result_log.py). A recorder must never change a verdict;
    the outcome is printed either way, so "wrote nothing" never reads like "wrote a record"."""
    ok, detail = _append_result(RESULT_CANARY, verdict, exit_code, metrics)
    print("CANARY_RESULT_LOG=%s %s" % ("ok" if ok else "skipped", detail))


def emit(verdict, exit_code):
    print("%s=%s" % (VERDICT_TOKEN, verdict))
    return exit_code


def main():
    breaches = []
    info = []
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    lo, hi = (d.isoformat() for d in window_bounds(DEAD_BOOK_WINDOW_DAYS).dates(now.date()))

    def indeterminate(what):
        print("[book-liveness-canary] %s INDETERMINATE - %s" % (stamp, what), file=sys.stderr)
        record_result("INDETERMINATE", EXIT_INDETERMINATE, {"reason": str(what)[:300]})
        return emit("INDETERMINATE", EXIT_INDETERMINATE)

    if pr is None:
        return indeterminate("population_rate unavailable (%s) - the N-of-D bound cannot be "
                             "enforced, so no window verdict is trusted" % _RATE_IMPORT_ERROR)

    try:
        mode = probe_mode()
    except QueryError as e:
        return indeterminate(e)

    if mode == "off":
        # A FACT about the world, reported positively. The gate is not running, so there is
        # nothing for these checks to be right or wrong about.
        print("[book-liveness-canary] %s gate mode=off - no gate to watch" % stamp)
        record_result("PASS", 0, {"mode": mode})
        return emit("PASS", 0)

    reason = reason_for(mode)

    try:
        srows = parse_rows(psql(build_shadow_recency_sql()), 1)
    except QueryError as e:
        return indeterminate("shadow-recency query: %s" % e)
    shadow_age = int(srows[0][0] or 0) if srows else 99999

    frozen_table, table_label = frozen_table_for(mode, shadow_age, LOOKBACK_DAYS)
    info.append("gate mode=%s (frozen ceilings=%s, suppression reason=%s)"
                % (mode, table_label, reason))
    if "MIXED_WINDOW" in table_label:
        info.append("frozen window MIXED_WINDOW - shadow last wrote %dd ago, lookback is %dd; the "
                    "enforce ratchet engages once the window is entirely post-transition"
                    % (shadow_age, LOOKBACK_DAYS))

    # -- 1. frozen-row rate --
    try:
        frozen = parse_rows(psql(build_frozen_sql(LOOKBACK_DAYS)), 3)
    except QueryError as e:
        return indeterminate("frozen query: %s" % e)

    evaluated = 0
    for row in frozen:
        venue, n_eval, n_frozen = row[0], int(row[1] or 0), int(row[2] or 0)
        if n_eval < MIN_DENOM:
            info.append("frozen %s: SKIPPED, n_eval=%d < MIN_DENOM=%d"
                        % (venue, n_eval, MIN_DENOM))
            continue
        evaluated += 1
        pct = 100.0 * n_frozen / n_eval
        cap = ceiling(frozen_table, venue)
        line = "frozen %s: %.2f%% (%d/%d), ceiling %.1f%%" % (venue, pct, n_frozen, n_eval, cap)
        (breaches if pct > cap else info).append(line)

    # -- 2. dead-book persistence (its own alert id, paged on the CHANGE) --
    try:
        prows = parse_rows(psql(build_persistence_sql(DEAD_BOOK_WINDOW_DAYS)), 6)
    except QueryError as e:
        return indeterminate("persistence query: %s" % e)

    try:
        arows = parse_rows(psql(build_counter_age_sql()), 1)
    except QueryError as e:
        return indeterminate("counter-age query: %s" % e)

    counter_age = int(arows[0][0] or 0) if arows else 0
    counter_min_date = (arows[0][1] if arows and len(arows[0]) > 1 else "") or ""
    days_seen = int(prows[0][5] or 0) if prows else 0
    try:
        dead, evaluable = classify_persistence(prows, DEAD_BOOK_MIN_DAYS, DEAD_BOOK_WINDOW_DAYS,
                                               days_seen, counter_age)
    except pr.InstrumentDefect as e:
        # "29 of the last 28": a row carrying more dates than its window is a defect of the
        # INSTRUMENT, not a fact about a book — never paged, never counted.
        return indeterminate("instrument_defect: %s" % e)
    if not evaluable:
        # R2: the gap carries its own END DATE, in the output, beside the number it qualifies,
        # so a reader meets the expiry where they meet the blindness rather than in a status
        # file they may never open. Until that date there is NO dead-book detection AT ALL:
        # under enforce a dead book emits nothing, so it mints no frozen rows either, and the
        # frozen-row check above is structurally blind to it (measured 2026-08-29: zero
        # directional emissions post-flip on all five known dead books).
        info.append("persistence: INSUFFICIENT_WINDOW - the counter is %d day(s) old, needs %d; "
                    "%s (%d day(s) carry a suppression). NO dead-book detection until then."
                    % (counter_age, DEAD_BOOK_WINDOW_DAYS,
                       window_complete_note(counter_min_date, DEAD_BOOK_WINDOW_DAYS), days_seen))
    else:
        evaluated += 1
        if not prows:
            # The target state, reported as a PASS rather than as an unknown.
            info.append("persistence: 0 suppressions in the last %d days over a full %d-day "
                        "counter - no dead books" % (DEAD_BOOK_WINDOW_DAYS,
                                                     DEAD_BOOK_WINDOW_DAYS))
        elif not dead:
            info.append("persistence: %d (venue,coin) pair(s) suppressed across %s, none "
                        "reaching %d of %d days" % (len(prows),
                                                    pr.bounded_fraction(days_seen,
                                                                        DEAD_BOOK_WINDOW_DAYS,
                                                                        "window dates"),
                                                    DEAD_BOOK_MIN_DAYS, DEAD_BOOK_WINDOW_DAYS))

    # -- 3. suppression volume floor (PROMOTED: a LEVEL check under ALERT_CEILING) --
    try:
        frows = parse_rows(psql(build_floor_sql(DEAD_BOOK_WINDOW_DAYS)), 2)
    except QueryError as e:
        return indeterminate("floor query: %s" % e)

    floor_breaches, floor_info = classify_floor(frows)
    breaches.extend(floor_breaches)
    info.append("floor: PROMOTED — pins = %d x the per-venue maximum measured %s over %d dates "
                "(FLOOR_REPORT_ONLY=%s)" % (FLOOR_PIN_MULTIPLE, FLOOR_MEASURED_AT,
                                           DEAD_BOOK_WINDOW_DAYS, FLOOR_REPORT_ONLY))
    info.extend(floor_info)

    # -- 2b. class every dead book through the admission step itself (DEAD_BOOK_CLASS) --
    classes, paged, thin = {}, [], []
    if evaluable and dead:
        try:
            verdicts, failure = admission_verdicts([d.key for d in dead]), None
        except AdmissionError as e:
            verdicts, failure = None, str(e)
            print("[book-liveness-canary] %s admission verdict UNAVAILABLE - %s; every dead key is "
                  "STATUS_UNKNOWN and pages (noise, never silence)" % (stamp, e), file=sys.stderr)
        classes, paged, thin = classify_dead_set(dead, verdicts, failure)
        info.append("dead-book classes (admission-verdict.js): %s" % (
            "UNAVAILABLE (%s)" % failure if failure else " · ".join(
                "%s %d" % (c, sum(1 for v in classes.values() if v["class"] == c)) for c in DEAD_CLASSES)))

    # -- verdict: FAIL describes the WORLD (a level breach, or a dead book the venue's own status
    #    does not explain). Whether the operator is paged about it is the wrapper's decision. --
    print("[book-liveness-canary] %s mode=%s - %d check(s) evaluated, %d line(s)"
          % (stamp, mode, evaluated, len(info) + len(breaches) + len(dead)))
    for ln in info:
        print("  %s" % ln)
    for ln in breaches:
        print("  BREACH %s" % ln)
    for d in paged:
        print("  BREACH dead book %s [%s] %s" % (d.line, classes[d.key]["class"], _class_detail(classes[d.key])))
    for d in thin:
        print("  dead book %s [THIN_LIVE, not paged] %s" % (d.line, _class_detail(classes[d.key])))
    if evaluable:
        print(THIN_LIVE_LINE % len(thin))

    verdict = "FAIL" if (breaches or paged) else "PASS"

    # ONE ALERT ID, ONE REMEDY — and each id hears from this run EVERY time: fire on its
    # condition, `--clear` without it. An unevaluable dead-book window sends nothing at all:
    # "could not judge" is not "nothing is dead".
    if breaches:
        body = build_ceiling_body(breaches, mode, stamp, lo, hi)
        fire_ceiling(body)
        print(body)
    else:
        clear_ceiling()
    action, keys = dead_book_dispatch(evaluable, paged)
    if action == "fire":
        dbody = build_dead_body(paged, thin, classes, mode, stamp, lo, hi)
        fire_dead_book(dbody, keys)
        print(dbody)
    elif action == "clear":
        clear_dead_book()

    record_result(verdict, 0, build_result_metrics(
        verdict, 0, mode, lo, hi, dead, frows, breaches, evaluable, counter_age,
        dead_class={k: v["class"] for k, v in classes.items()}))
    return emit(verdict, 0)


# == self-test ==

def emit_probe(verdict, code):
    """The token->exit-code association under test, without printing - so the self-test asserts
    the MAPPING and not merely the token string. Re-coding INDETERMINATE to 0 must fail here."""
    return (verdict, code)


def _quote_refused():
    try:
        _safe_literal("frozen_book'; DROP TABLE signals;--")
        return False
    except ValueError:
        return True


def _self_test():
    """Two-way, vacuity-guarded. Asserts the token->exit-code MAPPING and the artifacts the DB
    seam bypasses (SQL builders, row parser), not just the classifier verdicts.

    Every check reports FAIL; nothing here may RAISE, because an assertion that aborts the suite
    converts "proven able to fail" into "crashes" and prints no verdict at all.
    """
    failures = []
    checks = 0

    def ck(name, fn, want):
        nonlocal checks
        checks += 1
        try:
            got = fn()
        except Exception as e:  # noqa: BLE001
            failures.append("%s: RAISED %r" % (name, e))
            return
        if got != want:
            failures.append("%s: got %r want %r" % (name, got, want))

    # resolver mirrors the shipped TS resolver, both directions
    ck("kill switch dominates", lambda: resolve_mode("0", "enforce"), "off")
    ck("unset is off", lambda: resolve_mode(None, "enforce"), "off")
    ck("enabled+garbage is shadow", lambda: resolve_mode("1", "ENFORC"), "shadow")
    ck("enabled+enforce", lambda: resolve_mode("true", "ENFORCE"), "enforce")
    ck("enabled+shadow", lambda: resolve_mode("1", "shadow"), "shadow")

    # reason mapping is single-derived
    ck("reason enforce", lambda: reason_for("enforce"), "frozen_book")
    ck("reason shadow", lambda: reason_for("shadow"), "frozen_book_shadow")
    ck("reason off maps to shadow", lambda: reason_for("off"), "frozen_book_shadow")

    # SQL builders: the DB seam bypasses these entirely
    ck("frozen sql scopes the window", lambda: "3*86400" in build_frozen_sql(3), True)
    ck("persistence sql scopes the window with THE bound",
       lambda: window_bounds(28).sql in build_persistence_sql(28), True)
    ck("persistence sql carries the window-days-seen subquery",
       lambda: "window_days_seen" in build_persistence_sql(28), True)

    # -- THE ANTI-RESET PROPERTY --------------------------------------------------------------
    # A detector window keyed on a MUTABLE reason restarts itself every time the reason changes.
    # Measured 2026-08-29: the shadow->enforce flip silently reset this detector to zero and
    # dropped 3 of 5 known dead books to zero recorded days. These four checks make the window
    # provably independent of the stage, so a flip, a re-key or a new reason string cannot
    # restart it again. If a future wave re-introduces `reason = ` into any of these three
    # builders, these FAIL - that is the whole point of asserting on the SQL text.
    ck("persistence sql is REASON-INDEPENDENT",
       lambda: "reason" in build_persistence_sql(28), False)
    ck("counter-age sql is REASON-INDEPENDENT",
       lambda: "reason" in build_counter_age_sql(), False)
    ck("floor sql is REASON-INDEPENDENT",
       lambda: "reason" in build_floor_sql(28), False)
    ck("a stage change cannot alter ANY window query",
       lambda: (build_persistence_sql(28), build_counter_age_sql(), build_floor_sql(28))
               == (build_persistence_sql(28), build_counter_age_sql(), build_floor_sql(28)),
       True)
    ck("builder refuses a quote-bearing literal", _quote_refused, True)

    # parser: field splitting and short-row rejection
    ck("parser splits and drops blanks",
       lambda: parse_rows("A|1|2\n\nB|3|4", 3), [["A", "1", "2"], ["B", "3", "4"]])
    ck("parser drops short rows", lambda: parse_rows("A|1", 3), [])
    ck("parser on empty input", lambda: parse_rows("", 3), [])
    ck("parser on None", lambda: parse_rows(None, 3), [])

    # classifier, both directions, plus the young-counter guard
    dead_row = ["XT", "EPT", "26", "3", "40", "28"]
    live_row = ["ASTER", "SPY", "6", "1", "6", "28"]
    ck("dead book detected",
       lambda: len(classify_persistence([dead_row], 24, 28, 28, 28)[0]), 1)
    ck("closed market NOT flagged",
       lambda: len(classify_persistence([live_row], 24, 28, 28, 28)[0]), 0)
    ck("mixed corpus flags only the dead one",
       lambda: len(classify_persistence([dead_row, live_row], 24, 28, 28, 28)[0]), 1)
    ck("young COUNTER is not evaluable",
       lambda: classify_persistence([dead_row], 24, 28, 4, 4)[1], False)
    ck("young counter yields no verdict",
       lambda: len(classify_persistence([dead_row], 24, 28, 4, 4)[0]), 0)
    ck("full window is evaluable",
       lambda: classify_persistence([live_row], 24, 28, 28, 28)[1], True)
    # The target state: a mature counter with ZERO suppressions is a PASS, never an unknown.
    # Keying evaluability on days_seen instead of counter age would call success "insufficient".
    ck("mature counter with zero suppressions IS evaluable",
       lambda: classify_persistence([], 24, 28, 0, 28)[1], True)
    ck("mature counter with zero suppressions finds no dead books",
       lambda: len(classify_persistence([], 24, 28, 0, 28)[0]), 0)
    ck("counter-age sql is NOT window-bounded",
       lambda: "INTERVAL" not in build_counter_age_sql(), True)
    ck("counter-age sql also returns the first-row date",
       lambda: "MIN(date)::text" in build_counter_age_sql(), True)
    ck("completion date is projected from the counter's OWN first row",
       lambda: window_complete_note("2026-08-25", 28), "full coverage on 2026-09-21")
    ck("a re-seeded counter moves the completion date with it",
       lambda: window_complete_note("2026-09-01", 28), "full coverage on 2026-09-28")
    ck("an empty counter says so rather than projecting a fake date",
       lambda: window_complete_note("", 28),
       "no suppressions recorded yet, so the window has not started")

    # MIXED_WINDOW: the ratchet must NOT bite while the window still carries shadow-era rows
    ck("shadow mode uses the shadow table",
       lambda: frozen_table_for("shadow", 0, 3)[1], "shadow")
    ck("enforce with a FRESH shadow tail defers the ratchet",
       lambda: frozen_table_for("enforce", 0, 3)[1], "shadow (MIXED_WINDOW)")
    ck("enforce with a fresh tail really returns the LOOSER table",
       lambda: frozen_table_for("enforce", 0, 3)[0] is FROZEN_CEILING_PCT_SHADOW, True)
    ck("enforce past the lookback engages the ratchet",
       lambda: frozen_table_for("enforce", 3, 3)[1], "enforce")
    ck("enforce with no shadow history ever engages immediately",
       lambda: frozen_table_for("enforce", 99999, 3)[1], "enforce")
    # The ONE query that SHOULD be stage-scoped: "when did the previous stage last write" is a
    # question ABOUT the stage. Asserted so the two kinds are never conflated again.
    ck("shadow-recency sql scopes the shadow reason ON PURPOSE",
       lambda: "reason = 'frozen_book_shadow'" in build_shadow_recency_sql(), True)

    # ceiling lookup falls back, and the enforce table really is the ratchet
    ck("shadow ceiling per venue", lambda: ceiling(FROZEN_CEILING_PCT_SHADOW, "XT"), 6.0)
    ck("shadow ceiling default", lambda: ceiling(FROZEN_CEILING_PCT_SHADOW, "BINANCE"), 1.0)
    ck("enforce ratchets every venue", lambda: ceiling(FROZEN_CEILING_PCT_ENFORCE, "XT"), 1.0)
    ck("enforce is strictly tighter than shadow for XT",
       lambda: ceiling(FROZEN_CEILING_PCT_ENFORCE, "XT") < ceiling(FROZEN_CEILING_PCT_SHADOW,
                                                                   "XT"), True)

    # token -> exit-code mapping, asserted as the shipped DATA and not as a local copy
    ck("PASS maps to 0", lambda: emit_probe("PASS", 0), ("PASS", 0))
    ck("FAIL maps to 0", lambda: emit_probe("FAIL", 0), ("FAIL", 0))
    ck("INDETERMINATE maps to 3",
       lambda: emit_probe("INDETERMINATE", EXIT_INDETERMINATE), ("INDETERMINATE", 3))
    ck("token vocabulary is exactly three values",
       lambda: sorted(_token_exit_map()), ["FAIL", "INDETERMINATE", "PASS"])
    ck("shipped map agrees with the mapping under test",
       lambda: _token_exit_map(), {"PASS": 0, "FAIL": 0, "INDETERMINATE": 3})

    # -- ONE WINDOW DERIVATION (OPS-ALARM-SINGLE-DERIVATION-W1 CH4) -----------------------------
    # "29 of the last 28": the interval form spanned D+1 dates. Every window consumer now reads
    # window_bounds(D), and a row that still carries more dates than its window is an INSTRUMENT
    # defect (INDETERMINATE), never a page.
    def _raises(fn, exc):
        try:
            fn()
        except exc:
            return True
        return False

    wb = window_bounds(28)
    ck("window_bounds gives EXACTLY D dates", lambda: (wb.days, wb.lo_offset), (28, 27))
    ck("window_bounds dates span exactly D dates inclusive",
       lambda: (lambda b: (b[1] - b[0]).days + 1)(wb.dates(datetime(2026, 9, 30).date())), 28)
    ck("window_bounds refuses an empty window", lambda: _raises(lambda: window_bounds(0), ValueError),
       True)
    ck("persistence sql carries THE bound, for its rows and its window_days_seen",
       lambda: build_persistence_sql(28).count(wb.sql), 2)
    ck("floor sql carries THE bound", lambda: build_floor_sql(28).count(wb.sql), 1)
    ck("no window query is interval-derived (the D+1 form)",
       lambda: any("INTERVAL" in q for q in (build_persistence_sql(28), build_floor_sql(28))), False)
    ck("window_complete_note projects with THE bound's offset",
       lambda: window_complete_note("2026-08-25", 28)
       == "full coverage on %s" % (datetime(2026, 8, 25).date()
                                   + timedelta(days=wb.lo_offset)).isoformat(), True)
    ck("a row carrying 29 dates in a 28-date window is an instrument_defect",
       lambda: _raises(lambda: classify_persistence([["XT", "EPT", "29", "3", "140", "28"]],
                                                    24, 28, 28, 40), pr.InstrumentDefect), True)
    ck("the N-of-D text comes from the bounded-fraction helper",
       lambda: classify_persistence([dead_row], 24, 28, 28, 28)[0][0].n_of_d, "26 of 28 days")
    ck("a dead book's page key is an ENTITY id",
       lambda: classify_persistence([dead_row], 24, 28, 28, 28)[0][0].key, "dead:XT|EPT")

    # -- ONE ALERT ID, ONE REMEDY ---------------------------------------------------------------
    ck("both remedies are TEMPLATED",
       lambda: all(re.search(r"^OPS-[A-Z0-9-]+-W\{NEXT\}$", w) for w in (WAVE_CEILING, WAVE_DEAD_BOOK)),
       True)
    ck("the two remedies are DISTINCT", lambda: WAVE_CEILING != WAVE_DEAD_BOOK, True)
    ck("the two alert ids are DISTINCT", lambda: ALERT_CEILING != ALERT_DEAD_BOOK, True)
    cbody = build_ceiling_body(["frozen XT: 8.00% (40/500), ceiling 6.0%"], "enforce", "T",
                               "2026-09-03", "2026-09-30")
    def _safe(name, fn, default):
        """Build a fixture inside the suite: a builder that RAISES is a recorded FAIL, never a crash."""
        nonlocal checks
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            checks += 1
            failures.append("%s: RAISED %r" % (name, e))
            return default

    one_dead = classify_persistence([dead_row], 24, 28, 28, 28)[0]
    off_v = {"dead:XT|EPT": {"key": "dead:XT|EPT", "class": "VENUE_OFF", "status_state": "ok",
                             "venue_last_trade": "2026-01-30T00:00:00.000Z", "traded_bars_24h": 0,
                             "reason": "XT's own status switches it off"}}
    oc, op, ot = _safe("classify VENUE_OFF fixture", lambda: classify_dead_set(one_dead, off_v), ({}, [], []))
    dbody = _safe("VENUE_OFF body", lambda: build_dead_body(op, ot, oc, "enforce", "T", "2026-09-03", "2026-09-30"), "")
    ck("the LEVEL body names only the LEVEL remedy",
       lambda: (WAVE_CEILING in cbody, WAVE_DEAD_BOOK in cbody), (True, False))
    ck("a VENUE_OFF dead-book body names only the ADMISSION remedy",
       lambda: (WAVE_DEAD_BOOK in dbody, WAVE_CEILING in dbody), (True, False))
    ck("both bodies carry the runbook as a full blob URL",
       lambda: (RUNBOOK_URL.startswith("https://github.com/"), RUNBOOK_URL in cbody,
                RUNBOOK_URL in dbody), (True, True, True))
    ck("no body carries a BARE runbook filename",
       lambda: any("RUNBOOK-BOOK-LIVENESS-FLIP.md" in b.replace(RUNBOOK_URL, "") for b in (cbody, dbody)),
       False)
    ck("the dead-book body lists each key with its days, timeframes, class, status, last trade, bars",
       lambda: "dead:XT|EPT — suppressed on 26 of 28 days across 3 timeframe(s) — VENUE_OFF: status ok · "
               "last trade 2026-01-30T00:00:00.000Z · traded bars 24h 0 · " in dbody, True)

    # -- DEAD_BOOK_CLASS (OPS-ALARM-OWNER-DERIVATION-W1 CH2) ------------------------------------
    ck("the paged classes are exactly the three with an operator action",
       lambda: sorted(PAGED_CLASSES), ["ADAPTER_CONTRADICTION", "STATUS_UNKNOWN", "VENUE_OFF"])
    ck("THIN_LIVE is never paged", lambda: "THIN_LIVE" in PAGED_CLASSES, False)
    ck("the class vocabulary is the admission module's, in precedence order",
       lambda: DEAD_CLASSES, ("STATUS_UNKNOWN", "VENUE_OFF", "ADAPTER_CONTRADICTION", "THIN_LIVE"))
    ck("one remedy per paged class: admission · admission · the gate/adapter",
       lambda: (CLASS_REMEDY["VENUE_OFF"], CLASS_REMEDY["STATUS_UNKNOWN"], CLASS_REMEDY["ADAPTER_CONTRADICTION"]),
       (WAVE_DEAD_BOOK, WAVE_DEAD_BOOK, WAVE_CEILING))
    ck("the seam is the app container's own admission step",
       lambda: ADMISSION_CMD, ["docker", "exec", APP_CONTAINER, "node", "dist/scripts/admission-verdict.js", "--keys"])

    two = [DeadBook("ASTER", "EWT", 25, 3, "25 of 28 days"), DeadBook("ASTER", "KSTR", 25, 3, "25 of 28 days")]
    keys2 = [d.key for d in two]

    def _row(key, cls, **kw):
        return dict({"key": key, "class": cls, "symbol": None, "status_state": "ok", "venue_last_trade": None,
                     "traded_bars_24h": 0, "contradiction_check": "outside_window", "reason": "r"}, **kw)

    good = "\n".join(["[universe-admission] ASTER admitted 574 excluded 46",
                      json.dumps({"generated_at": "T", "keys": [_row(k, "THIN_LIVE") for k in keys2]}),
                      "ADMISSION_VERDICT_EMIT=PASS"])
    ck("the parser reads the JSON line past the app's own log lines",
       lambda: sorted(v["class"] for v in parse_admission_output(good, keys2).values()), ["THIN_LIVE", "THIN_LIVE"])
    ck("an INDETERMINATE script run is an AdmissionError",
       lambda: _raises(lambda: parse_admission_output("ADMISSION_VERDICT_EMIT=INDETERMINATE", keys2), AdmissionError), True)
    ck("no token at all is an AdmissionError",
       lambda: _raises(lambda: parse_admission_output(good.rsplit("\n", 1)[0], keys2), AdmissionError), True)
    ck("a key the script did not class is an AdmissionError",
       lambda: _raises(lambda: parse_admission_output(good, keys2 + ["dead:XT|EPT"]), AdmissionError), True)
    ck("a class outside the vocabulary is an AdmissionError",
       lambda: _raises(lambda: parse_admission_output(good.replace("THIN_LIVE", "MAYBE"), keys2), AdmissionError), True)

    all_thin = {k: _row(k, "THIN_LIVE") for k in keys2}
    tc, tp, tt = _safe("classify all-THIN fixture", lambda: classify_dead_set(two, all_thin), ({}, [], []))
    ck("an all-THIN_LIVE dead set pages nothing", lambda: (len(tp), len(tt)), (0, 2))
    ck("an all-THIN_LIVE dead set CLEARS the dead-book id", lambda: dead_book_dispatch(True, tp), ("clear", None))
    ck("an all-THIN_LIVE dead set prints the positive line",
       lambda: THIN_LIVE_LINE % len(tt),
       "DEAD_BOOKS_THIN_LIVE=2 (not paged: the venue lists them tradeable; the emit gate is suppressing correctly)")
    fc, fp, ft = _safe("classify failed-script fixture",
                       lambda: classify_dead_set(two, None, "docker exec: no such container"), ({}, [], []))
    ck("a failed verdict script pages EVERY key as STATUS_UNKNOWN",
       lambda: ([d.key for d in fp], sorted({v["class"] for v in fc.values()}), len(ft)),
       (keys2, ["STATUS_UNKNOWN"], 0))
    ck("…and the failure is named in each key's reason",
       lambda: all("docker exec: no such container" in v["reason"] for v in fc.values()), True)
    ck("…and the dead-book id FIRES with every key", lambda: dead_book_dispatch(True, fp), ("fire", keys2))
    ck("an unevaluable window says nothing to the dead-book id", lambda: dead_book_dispatch(False, fp), (None, None))
    mixed = {keys2[0]: _row(keys2[0], "THIN_LIVE"), keys2[1]: _row(keys2[1], "ADAPTER_CONTRADICTION")}
    mc, mp, mt = _safe("classify mixed fixture", lambda: classify_dead_set(two, mixed), ({}, [], []))
    ck("a mixed set pages only the actionable key", lambda: dead_book_dispatch(True, mp), ("fire", [keys2[1]]))
    mbody = _safe("mixed body", lambda: build_dead_body(mp, mt, mc, "enforce", "T", "2026-09-13", "2026-10-10"), "")
    ck("an ADAPTER_CONTRADICTION body names the gate/adapter remedy, not admission",
       lambda: ("recommended_wave: %s" % WAVE_CEILING in mbody, WAVE_DEAD_BOOK in mbody), (True, False))
    ck("the body counts what it did NOT page", lambda: "DEAD_BOOKS_THIN_LIVE=1 " in mbody, True)
    ubody = _safe("STATUS_UNKNOWN body", lambda: build_dead_body(fp, ft, fc, "enforce", "T", "2026-09-13", "2026-10-10"), "")
    ck("a STATUS_UNKNOWN body says which venue needs a status source",
       lambda: "declare a status source for ASTER" in ubody, True)
    ck("the static two-branch paragraph is gone — the class IS that runbook step",
       lambda: any("lists it as live, the book is genuinely thin" in b or "A NEW dead book on a venue" in b
                   for b in (dbody, mbody, ubody)), False)
    pre_wave = _safe("pre-wave record", lambda: build_result_metrics(
        "FAIL", 0, "enforce", "2026-09-13", "2026-10-10", two, [], [], True, 47), {})
    classed = _safe("classed record", lambda: build_result_metrics(
        "PASS", 0, "enforce", "2026-09-13", "2026-10-10", two, [], [], True, 47,
        dead_class={k: v["class"] for k, v in mc.items()}), {})
    ck("dead_keys is IDENTICAL to the pre-wave derivation on the same fixture",
       lambda: (classed["dead_keys"], classed["dead_keys"] == pre_wave["dead_keys"]), (keys2, True))
    ck("the record carries every key's class and the paged subset",
       lambda: (classed["dead_key_class"], classed["paged_keys"]),
       ({keys2[0]: "THIN_LIVE", keys2[1]: "ADAPTER_CONTRADICTION"}, [keys2[1]]))

    # -- the PROMOTED floor -------------------------------------------------------------------
    ck("the floor is promoted", lambda: FLOOR_REPORT_ONLY, False)
    ck("floor pins are 3x the measured maxima", lambda: (FLOOR_PINS["ASTER"], FLOOR_PINS["BITGET"]),
       (3180, 3))
    ck("a floor ABOVE its pin breaches", lambda: len(classify_floor([["ASTER", "3181", "2026-09-30"]])[0]),
       1)
    ck("a floor AT its pin does not", lambda: len(classify_floor([["ASTER", "3180"]])[0]), 0)
    ck("a venue with no observed maximum is REPORT-ONLY, never a pin of 0",
       lambda: (len(classify_floor([["BINANCE", "5"]])[0]),
                "report-only" in classify_floor([["BINANCE", "5"]])[1][0]), (0, True))
    ck("floor sql reports the date of each venue's busiest day",
       lambda: "array_agg(date ORDER BY d DESC)" in build_floor_sql(28), True)

    # -- the bounded result line: the dead-set KEYS make the close condition machine-checkable --
    many = [DeadBook("XT", "C%04d" % i, 28, 3, "28 of 28 days") for i in range(2000)]
    big = build_result_metrics("FAIL", 0, "enforce", "2026-09-03", "2026-09-30", many, [], [], True, 36)
    ck("an oversize dead set is TRUNCATED and the drop is RECORDED",
       lambda: (big["dead_keys_dropped"] > 0, len(big["dead_keys"]) + big["dead_keys_dropped"]),
       (True, 2000))
    ck("the bounded record fits the recorder's line cap",
       lambda: len((_build_record(RESULT_CANARY, "FAIL", 0, big) if _build_record
                    else json.dumps(big)).encode("utf-8")) <= _RESULT_MAX_BYTES, True)
    small = build_result_metrics("FAIL", 0, "enforce", "2026-09-03", "2026-09-30",
                                 [DeadBook("XT", "EPT", 28, 3, "28 of 28 days")], [["ASTER", "10"]],
                                 [], True, 36)
    ck("a normal dead set is carried WHOLE",
       lambda: (small["dead_keys"], small["dead_keys_dropped"], small["floor_max"]),
       (["dead:XT|EPT"], 0, {"ASTER": 10}))

    # VACUITY GUARD: in --self-test WE build the corpus, so empty means the test built nothing.
    # That is a defect in the TEST and must REFUSE, never report a pass.
    if checks == 0:
        print("SELF-TEST: REFUSE - zero checks executed (vacuous corpus)")
        print("%s=INDETERMINATE" % VERDICT_TOKEN)
        return EXIT_INDETERMINATE

    if failures:
        for f in failures:
            print("  FAIL %s" % f)
        print("SELF-TEST: FAIL (%d of %d)" % (len(failures), checks))
        print("%s=FAIL" % VERDICT_TOKEN)
        return 0

    print("SELF-TEST: PASS (%d checks)" % checks)
    print("%s=PASS" % VERDICT_TOKEN)
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(_self_test())
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 - the canary must never break its cron chain
        print("[book-liveness-canary] FATAL: %s" % e, file=sys.stderr)
        print("%s=INDETERMINATE" % VERDICT_TOKEN)
        sys.exit(EXIT_INDETERMINATE)

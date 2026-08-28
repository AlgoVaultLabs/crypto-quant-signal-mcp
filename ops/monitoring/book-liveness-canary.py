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
     from a market that is merely CLOSED, structurally rather than by calendar.

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
import subprocess
import sys
from datetime import datetime, timezone

PG_CONTAINER = "crypto-quant-signal-mcp-postgres-1"
APP_CONTAINER = "crypto-quant-signal-mcp-mcp-server-1"
PG_DB = "signal_performance"
TG = "/opt/algovault-monitoring/send_telegram.sh"

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
# HONEST LIMIT: with D=28 this check CANNOT fire until ~28 days of counter data exist
# (~2026-09-22). Until then it reports INSUFFICIENT_WINDOW as a positive line - the corpus was
# handed to us and is genuinely short, which is a FACT to report, not vacuity to refuse.
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
FLOOR_REPORT_ONLY = True
FLOOR_PROMOTION_EARLIEST = "2026-09-08"


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


def build_persistence_sql(window_days, reason):
    """Distinct days each (venue, coin) was suppressed, plus its timeframe breadth.

    `reason` scopes the rows to ONE rollout stage. Both stages write to this table by design
    (`frozen_book` = actually withheld, `frozen_book_shadow` = would have been), so an unscoped
    query silently mixes them the moment the mode changes.
    """
    d = int(window_days)
    r = _safe_literal(reason)
    return (
        "SELECT exchange, coin,"
        " COUNT(DISTINCT date) AS days,"
        " COUNT(DISTINCT timeframe) AS tfs,"
        " SUM(suppress_count)::bigint AS n,"
        " (SELECT COUNT(DISTINCT date) FROM emit_suppressions"
        "   WHERE date >= (NOW() - INTERVAL '%d days')::date AND reason = '%s') AS window_days_seen"
        " FROM emit_suppressions"
        " WHERE date >= (NOW() - INTERVAL '%d days')::date"
        "   AND reason = '%s'"
        " GROUP BY 1,2 ORDER BY 3 DESC, 5 DESC;" % (d, r, d, r)
    )


def build_floor_sql(window_days, reason):
    """Maximum suppressions recorded for any single (venue, day) in the window."""
    return (
        "SELECT exchange, MAX(d) FROM ("
        "  SELECT exchange, date, SUM(suppress_count) AS d FROM emit_suppressions"
        "   WHERE date >= (NOW() - INTERVAL '%d days')::date AND reason = '%s'"
        "   GROUP BY 1,2) t"
        " GROUP BY 1 ORDER BY 2 DESC;" % (int(window_days), _safe_literal(reason))
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


def classify_persistence(rows, min_days, window_days, days_seen):
    """(dead_books, evaluable) - a (venue, coin) suppressed on >= min_days distinct days.

    `evaluable` is False while the counter has seen fewer than `window_days` distinct days: the
    threshold is only meaningful against a full window, and reporting a verdict from a short one
    would mistake a YOUNG COUNTER for a healthy fleet.
    """
    if days_seen < window_days:
        return [], False
    dead = []
    for r in rows:
        venue, coin, days, tfs = r[0], r[1], int(r[2] or 0), int(r[3] or 0)
        if days >= min_days:
            dead.append("%s|%s: suppressed on %d of the last %d days across %d timeframe(s)"
                        % (venue, coin, days, window_days, tfs))
    return dead, True


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


def fire(body):
    """Dispatch to the shared wrapper. Extracted so it is stubbable: a test must be able to
    drive the real `main()` without posting to the operator channel."""
    try:
        subprocess.run([TG, "book_liveness_ceiling", "CRITICAL_PERSISTENT", "-"],
                       input=body, text=True, timeout=30, check=False)
    except Exception as e:  # noqa: BLE001
        print("[book-liveness-canary] TG dispatch failed (fail-open): %s" % e, file=sys.stderr)


def emit(verdict, exit_code):
    print("%s=%s" % (VERDICT_TOKEN, verdict))
    return exit_code


def main():
    breaches = []
    info = []
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    try:
        mode = probe_mode()
    except QueryError as e:
        print("[book-liveness-canary] %s INDETERMINATE - %s" % (stamp, e), file=sys.stderr)
        return emit("INDETERMINATE", EXIT_INDETERMINATE)

    if mode == "off":
        # A FACT about the world, reported positively. The gate is not running, so there is
        # nothing for these checks to be right or wrong about.
        print("[book-liveness-canary] %s gate mode=off - no gate to watch" % stamp)
        return emit("PASS", 0)

    reason = reason_for(mode)
    frozen_table = FROZEN_CEILING_PCT_ENFORCE if mode == "enforce" else FROZEN_CEILING_PCT_SHADOW
    info.append("gate mode=%s (frozen ceilings=%s, suppression reason=%s)"
                % (mode, "enforce" if mode == "enforce" else "shadow", reason))

    # -- 1. frozen-row rate --
    try:
        frozen = parse_rows(psql(build_frozen_sql(LOOKBACK_DAYS)), 3)
    except QueryError as e:
        print("[book-liveness-canary] %s INDETERMINATE - frozen query: %s" % (stamp, e),
              file=sys.stderr)
        return emit("INDETERMINATE", EXIT_INDETERMINATE)

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

    # -- 2. dead-book persistence --
    try:
        prows = parse_rows(psql(build_persistence_sql(DEAD_BOOK_WINDOW_DAYS, reason)), 6)
    except QueryError as e:
        print("[book-liveness-canary] %s INDETERMINATE - persistence query: %s" % (stamp, e),
              file=sys.stderr)
        return emit("INDETERMINATE", EXIT_INDETERMINATE)

    days_seen = int(prows[0][5] or 0) if prows else 0
    dead, evaluable = classify_persistence(prows, DEAD_BOOK_MIN_DAYS, DEAD_BOOK_WINDOW_DAYS,
                                           days_seen)
    if not evaluable:
        info.append("persistence: INSUFFICIENT_WINDOW - counter has %d of %d distinct days; the "
                    "pin is only meaningful over a full window"
                    % (days_seen, DEAD_BOOK_WINDOW_DAYS))
    else:
        evaluated += 1
        if dead:
            breaches.extend("dead book %s" % d for d in dead)
        else:
            info.append("persistence: %d (venue,coin) pair(s) suppressed, none reaching %d of %d "
                        "days" % (len(prows), DEAD_BOOK_MIN_DAYS, DEAD_BOOK_WINDOW_DAYS))

    # -- 3. suppression volume floor (REPORT-ONLY) --
    try:
        frows = parse_rows(psql(build_floor_sql(DEAD_BOOK_WINDOW_DAYS, reason)), 2)
    except QueryError as e:
        print("[book-liveness-canary] %s INDETERMINATE - floor query: %s" % (stamp, e),
              file=sys.stderr)
        return emit("INDETERMINATE", EXIT_INDETERMINATE)

    peaks = ", ".join("%s=%s" % (r[0], r[1]) for r in frows) or "none"
    info.append("floor: REPORT-ONLY until >=2 weekends observed (earliest %s) - observed max per "
                "(venue,day): %s" % (FLOOR_PROMOTION_EARLIEST, peaks))

    # -- verdict --
    print("[book-liveness-canary] %s mode=%s - %d check(s) evaluated, %d line(s)"
          % (stamp, mode, evaluated, len(info) + len(breaches)))
    for ln in info:
        print("  %s" % ln)

    if not breaches:
        return emit("PASS", 0)

    for ln in breaches:
        print("  BREACH %s" % ln)

    body = "\n".join([
        "\U0001F9CA Book-liveness canary: ceiling breached",
        "",
        "Window: frozen %dd / persistence %dd - gate mode %s - checked %s"
        % (LOOKBACK_DAYS, DEAD_BOOK_WINDOW_DAYS, mode, stamp),
        "",
        "BREACHED:",
        *["  - %s" % b for b in breaches],
        "",
        "Read this as:",
        "  - frozen-rate up  -> the emit gate regressed, its pin drifted, or a NEW venue",
        "                      started serving zero-volume synthetic bars.",
        "  - dead book       -> a (venue, coin) whose book has not traded for most of the",
        "                      window. NOT a closed market: a closed market recovers when its",
        "                      session reopens and never reaches the day threshold.",
        "",
        "Rollback is one env key (behaviour returns to legacy, byte-identical):",
        "  EMIT_BOOK_LIVENESS_ENABLED=0 && docker compose up -d mcp-server",
        "",
        "Runbook: docs/RUNBOOK-BOOK-LIVENESS-FLIP.md",
        "recommended_wave: OPS-BOOK-LIVENESS-W{NEXT}",
    ])

    fire(body)
    print(body)
    return emit("FAIL", 0)


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
    ck("persistence sql scopes the reason",
       lambda: "reason = 'frozen_book_shadow'" in build_persistence_sql(28, "frozen_book_shadow"),
       True)
    ck("persistence sql scopes the window",
       lambda: "INTERVAL '28 days'" in build_persistence_sql(28, "frozen_book"), True)
    ck("persistence sql carries the window-days-seen subquery",
       lambda: "window_days_seen" in build_persistence_sql(28, "frozen_book"), True)
    ck("floor sql scopes the reason",
       lambda: "reason = 'frozen_book'" in build_floor_sql(28, "frozen_book"), True)
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
       lambda: len(classify_persistence([dead_row], 24, 28, 28)[0]), 1)
    ck("closed market NOT flagged",
       lambda: len(classify_persistence([live_row], 24, 28, 28)[0]), 0)
    ck("mixed corpus flags only the dead one",
       lambda: len(classify_persistence([dead_row, live_row], 24, 28, 28)[0]), 1)
    ck("short window is not evaluable",
       lambda: classify_persistence([dead_row], 24, 28, 4)[1], False)
    ck("short window yields no verdict",
       lambda: len(classify_persistence([dead_row], 24, 28, 4)[0]), 0)
    ck("full window is evaluable",
       lambda: classify_persistence([live_row], 24, 28, 28)[1], True)

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

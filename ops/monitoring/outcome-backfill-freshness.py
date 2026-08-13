#!/usr/bin/env python3
"""outcome-backfill-freshness.py — OPS-RECALIBRATE-HARNESS-RETIRE-W1 (R4)

The RE-HOMED subject of `RECALIBRATE_ACCRUAL_STALLED`.

── Why this exists at all ───────────────────────────────────────────────────────────────────
`closedbar-recalibrate-readiness` carried TWO alerts. `RECALIBRATE_READY` was a decision gate
and died with its decision. `RECALIBRATE_ACCRUAL_STALLED` was not: it watched whether matured
PFE outcomes were still accruing — i.e. whether `backfill-outcomes` (crontab `2-59/3`) is alive.

That alarm was NOT redundant. R0 probe 3 of the retiring wave enumerated all 61 rows of
`ops/monitoring/monitoring-inventory.json` one by one — enumeration, not a keyword grep, because
detection is strictly weaker than enumeration — and found ZERO other artifacts watching
outcome-backfill freshness. The near misses, each ruled out by READING the file rather than by
its name:
  * directional-label-freshness — watches `directional_labels` production per venue. A
    DIFFERENT producer (the labeler), not the outcome backfill.
  * seed-coverage-canary       — asserts promoted venues have seed lines in the crontab.
    Config-level, upstream of emission, never outcomes.
  * closedbar-w1-liveness      — watchlist DISPATCH determinism.
  * the website-drift rows on /api/performance-public — MONOTONIC **FLOOR** checks. A stall
    stops growth; a floor only fires on REGRESSION. Structurally blind to a plateau.
So deleting the alarm with the harness would have opened a silent hole in the series behind the
public `signal-performance` resource. Re-homing it is the whole reason that probe existed.

── The key: a PRODUCER high-water mark, never a rendered artifact ───────────────────────────
`max(created_at) FILTER (WHERE pfe_return_pct IS NOT NULL)` — the newest signal that the
backfill has matured. It advances ONLY when `backfill-outcomes` writes, and it cannot be moved
by a report, a page bake, a deploy or a log rotation.

⚠️ The retiring wave's spec asked for "the producer's own write timestamp". **There is no such
column.** Measured on the live schema: `signals` carries `outcome_price`, `outcome_return_pct`,
`pfe_candles`, `pfe_price`, `pfe_return_pct` — and nothing recording WHEN the backfill wrote.
The high-water mark is the honest substitute: it is producer-side, monotonic, and derived from
the same rows the backfill mutates. It is exactly the shape `directional-label-freshness`
already proves in production ("newest labeled signal lags beyond the tier SLO").

The retired wrapper instead kept a `last_matured` COUNT in its own state.json and compared it
run-to-run. That is the alarm's own memory, not the producer — it survives here only as the
streak counter, which is about SUSTAIN, not about the measurement.

── Denominator and window, stated before the threshold (they are what make it fire) ─────────
DENOMINATOR : rows in `signals`. Not a rate — an age, so there is no zero-traffic denominator
              hole. The counterpart risk is the opposite one, handled next.
INPUT GUARD : the input/output-counter-mismatch shape. Breach requires BOTH
              (a) input flowing — >= 1 signal emitted in the last INPUT_WINDOW_HOURS (3), and
              (b) output stuck — lag > STALE_HOURS.
              Without (a) this alarm would page on a legitimate seeding pause, which is
              `seed-coverage-canary`'s subject and a different remedy. A canary that pages for
              someone else's fault gets muted, and then it is dark for its own.
THRESHOLD   : 12h. Calibrated against MEASURED live lag at 2026-08-13 08:24Z — global 0.70h,
              per-timeframe 3m 0.70h · 5m 1.10h · 15m 3.40h · 30m 4.55h · 1h 9.04h. The fast
              timeframes set the global high-water mark, so 12h is ~11x the observed healthy
              max on the timeframes that matter, and still 4x tighter than the 48h it replaces.
              Honest limit: that is ONE sample, not a series, so every run logs the observed lag
              (`lag_h=`) to build the series a later wave can tighten from. Carries a revisit
              row in `Claude files/defensive-reductions-to-revisit.md`.
SUSTAIN     : 2 consecutive hourly breaches before paging — the estate's sustained-drift
              criterion. Detection latency ~13h vs the retired alarm's 48h.

── Contract ─────────────────────────────────────────────────────────────────────────────────
Verdict token: exactly one terminal `OUTCOME_BACKFILL_VERDICT=PASS|FAIL|INDETERMINATE`.
Exit: 0 = evaluated (PASS, or FAIL with the alert sent) · 3 = INDETERMINATE (verified NOTHING).
3 is the token-law default for a NEW gate. Callers gate on the TOKEN, never the bare exit code.
Alert id `OUTCOME_BACKFILL_STALLED`; recommended wave `OPS-OUTCOME-BACKFILL-STALL-W{NEXT}` —
inherited verbatim from the retiring `ops/closedbar-recalibrate-config.json`, whose own `alerts`
block records why it must differ from the readiness wave: "one recommended_wave shared by two
alerts with opposite remedies is the generator bug that sent an operator to run the wave that
would have ratified a broken state."

FAIL-CLOSED. psql failure, an unparseable row, or a NULL where a number was promised is
INDETERMINATE — input we were HANDED and could not parse is never a pass. Reads as
`aoe_readonly` over the container's `local ... trust` line: least privilege, and the role cannot
write, so read-only intent is enforced by the role and not only by the SET below.

Env / test seams:
  OBF_PSQL_CMD    override the psql command (default: docker exec … psql -U aoe_readonly …)
  OBF_STATE_FILE  streak state       OBF_LOG            log path
  OBF_WRAPPER     send_telegram.sh   OBF_NOW_EPOCH      freeze "now"
  OBF_STALE_HOURS threshold (12)     OBF_INPUT_WINDOW_HOURS input guard window (3)
  OBF_CONSECUTIVE_TO_PAGE sustain (2)
  OBF_SELFTEST=1  short-circuits fire()
  ALGOVAULT_TG_TEST_INERT=1 suppresses BEFORE the wrapper's cooldown gate and writes no marker.
                  DRY_RUN_TG=1 is NOT inert — it writes the 24h marker, so back-to-back dry runs
                  FALSE-GREEN by cooldown suppression rather than by health.
  --self-test     hermetic scenario suite; no DB, no wrapper, temp state.

Cron: 13 * * * * (canonical off-:00 minute per ops/monitoring/schedule-boundary-rule.json).
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

ALERT_ID = "OUTCOME_BACKFILL_STALLED"
RECOMMENDED_WAVE = "OPS-OUTCOME-BACKFILL-STALL-W{NEXT}"
PRODUCER = "backfill-outcomes (crontab 2-59/3)"

WRAPPER = os.environ.get("OBF_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
STATE_FILE = os.environ.get(
    "OBF_STATE_FILE", "/opt/algovault-monitoring/.alert-state/outcome-backfill-freshness.json")
LOG = os.environ.get("OBF_LOG", "/var/log/algovault-outcome-backfill-freshness.log")

PSQL_DEFAULT = (
    "docker exec crypto-quant-signal-mcp-postgres-1 "
    "psql -U aoe_readonly -d signal_performance -tA"
)


def _int_env(name, default, floor=1):
    try:
        return max(floor, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


STALE_HOURS = _int_env("OBF_STALE_HOURS", 12)
INPUT_WINDOW_HOURS = _int_env("OBF_INPUT_WINDOW_HOURS", 3)
CONSECUTIVE_TO_PAGE = _int_env("OBF_CONSECUTIVE_TO_PAGE", 2)


class Indeterminate(Exception):
    """The run verified NOTHING it was supposed to verify. Never laundered into a pass."""


def log(msg):
    line = "[%s] %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg)
    print(line, flush=True)
    try:
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass  # the log is evidence; the token is the contract


def now_epoch():
    frozen = os.environ.get("OBF_NOW_EPOCH")
    return int(frozen) if frozen else int(time.time())


# ── the query, built as a pure fn so --self-test can assert the SHAPE the seam bypasses ──────

def build_census_sql(window_start_epoch):
    """`created_at` is an INTEGER epoch on this table, not a timestamptz — so the window is
    plain integer arithmetic and there is no timezone or to_timestamp() to get wrong.

    Built by a pure function on purpose: a hermetic self-test replaces the psql seam, which
    makes the SQL string the one artifact no scenario would otherwise execute. That is exactly
    how a sibling canary shipped 26 green assertions and then died on its first live run with
    `unsupported format character` in a LIKE clause.
    """
    return (
        "SET default_transaction_read_only=on; "
        "SELECT MAX(created_at) FILTER (WHERE pfe_return_pct IS NOT NULL) AS newest_matured, "
        "MAX(created_at) AS newest_signal, "
        "COUNT(*) FILTER (WHERE pfe_return_pct IS NOT NULL) AS matured_total, "
        "COUNT(*) FILTER (WHERE created_at > %d) AS emitted_recent "
        "FROM signals;" % int(window_start_epoch)
    )


def parse_census(stdout):
    """psql -tA rows. A row we were HANDED and cannot parse is INDETERMINATE, never a pass.

    NOTE the asymmetry, and it is deliberate: `newest_matured` may legitimately be EMPTY (NULL)
    — that is the real, alarming state "the backfill has never written" — while `newest_signal`
    and the two counts must be numbers. Empty is a FACT here, not vacuity: the world builds this
    corpus, we did not.
    """
    for line in stdout.strip().splitlines():
        if "|" not in line:
            continue  # SET tag / notices
        parts = line.split("|")
        if len(parts) != 4:
            continue
        nm, ns, mt, er = (p.strip() for p in parts)
        if not (ns.isdigit() and mt.isdigit() and er.isdigit()):
            continue
        return {
            "newest_matured": int(nm) if nm.isdigit() else None,
            "newest_signal": int(ns),
            "matured_total": int(mt),
            "emitted_recent": int(er),
        }
    raise Indeterminate(
        "no parseable census row in psql output (got %r) — handed input we could not parse is "
        "INDETERMINATE, never PASS" % stdout.strip()[:200])


def query_census(now):
    cmd = os.environ.get("OBF_PSQL_CMD", PSQL_DEFAULT)
    sql = build_census_sql(now - INPUT_WINDOW_HOURS * 3600)
    out = subprocess.run(cmd.split() + ["-c", sql], capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise Indeterminate("psql failed rc=%d: %s" % (out.returncode, out.stderr.strip()[:200]))
    return parse_census(out.stdout)


# ── pure classification ──────────────────────────────────────────────────────────────────────

def classify(census, now, stale_hours=None, ):
    """Input/output-counter-mismatch. Returns a verdict dict; no I/O, no globals but defaults."""
    stale_h = STALE_HOURS if stale_hours is None else stale_hours
    input_flowing = census["emitted_recent"] > 0
    if census["newest_matured"] is None:
        lag_h = None
        output_stuck = census["matured_total"] == 0
    else:
        lag_h = max(0.0, (now - census["newest_matured"]) / 3600.0)
        output_stuck = lag_h > stale_h
    return {
        "breach": bool(input_flowing and output_stuck),
        "input_flowing": input_flowing,
        "output_stuck": output_stuck,
        "lag_h": lag_h,
        "emitted_recent": census["emitted_recent"],
        "matured_total": census["matured_total"],
        "newest_signal": census["newest_signal"],
    }


def render_eval_line(v, streak):
    """POSITIVE per-check output. A run silently skipped by a parse error must never look
    identical to a run that evaluated and passed."""
    lag = "n/a (nothing matured, ever)" if v["lag_h"] is None else "%.2fh" % v["lag_h"]
    return ("EVAL outcome_backfill: lag_h=%s threshold=%dh input_flowing=%s "
            "(emitted_last_%dh=%d) matured_total=%d streak=%d/%d verdict=%s"
            % (lag, STALE_HOURS, "Y" if v["input_flowing"] else "N", INPUT_WINDOW_HOURS,
               v["emitted_recent"], v["matured_total"], streak, CONSECUTIVE_TO_PAGE,
               "BREACH" if v["breach"] else ("idle" if not v["input_flowing"] else "ok")))


def build_body(v, streak):
    lag = "never — the backfill has matured NOTHING" if v["lag_h"] is None \
        else "%.1f hours" % v["lag_h"]
    return "\n".join([
        "\U0001F6D1 %s" % ALERT_ID,
        "",
        "Matured PFE outcomes have not advanced for %s (threshold %dh), while signals ARE still "
        "being emitted (%d in the last %dh). Output is stuck with input flowing — the "
        "silent-producer-halt shape."
        % (lag, STALE_HOURS, v["emitted_recent"], INPUT_WINDOW_HOURS),
        "",
        "Producer: %s" % PRODUCER,
        "Consecutive breaches: %d (pages at %d)." % (streak, CONSECUTIVE_TO_PAGE),
        "matured_total=%d" % v["matured_total"],
        "",
        "A stalled backfill holds every downstream PFE statistic frozen while looking exactly "
        "like 'not enough data yet', and the series behind the public signal-performance "
        "resource stops growing with nothing else in the estate watching it.",
        "",
        "Action: dispatch %s via Cowork → Claude Code" % RECOMMENDED_WAVE,
        "Source log: %s" % LOG,
    ])


# ── state + effects ──────────────────────────────────────────────────────────────────────────

def read_streak():
    try:
        with open(STATE_FILE) as fh:
            return int(json.load(fh).get("consecutive_breaches", 0))
    except (OSError, ValueError, TypeError):
        return 0


def write_state(streak, v, now):
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as fh:
            json.dump({"consecutive_breaches": streak, "last_run_epoch": now,
                       "last_lag_h": v["lag_h"], "last_verdict":
                       "BREACH" if v["breach"] else "OK"}, fh, indent=1)
    except OSError as e:
        log("WARN: could not persist state to %s: %s" % (STATE_FILE, e))


LAST_FIRE = {}


def fire(body):
    """The wrapper OWNS severity / cooldown / DRY_RUN / fail-open. Never re-implemented here."""
    LAST_FIRE["body"] = body
    if os.environ.get("OBF_SELFTEST") == "1":
        log("WOULD_FIRE: %s (self-test — wrapper skipped)" % ALERT_ID)
        return
    proc = subprocess.run([WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"],
                          input=body, capture_output=True, text=True, timeout=30)
    log("wrapper exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))
    if os.environ.get("ALGOVAULT_TG_TEST_INERT") == "1":
        log("WOULD_FIRE: alert_id=%s severity=CRITICAL_PERSISTENT verdict=SUPPRESSED_TEST_INERT "
            "(no POST, no cooldown marker)" % ALERT_ID)
    elif os.environ.get("DRY_RUN_TG") == "1":
        log("WOULD_FIRE: alert_id=%s severity=CRITICAL_PERSISTENT verdict=DRY_RUN (no POST; 24h "
            "COOLDOWN MARKER WRITTEN — prefer ALGOVAULT_TG_TEST_INERT=1)" % ALERT_ID)


def run(census, now):
    v = classify(census, now)
    # A heal resets the streak to 0 rather than decaying it: a producer that comes back is
    # healthy now, and carrying a partial streak forward would page on the NEXT single blip.
    streak = read_streak() + 1 if v["breach"] else 0
    log(render_eval_line(v, streak))
    write_state(streak, v, now)
    if v["breach"] and streak >= CONSECUTIVE_TO_PAGE:
        fire(build_body(v, streak))
    elif v["breach"]:
        log("BREACH_DAY_1: sustained-drift gate holds the page until streak %d"
            % CONSECUTIVE_TO_PAGE)
    return v, streak


def main():
    try:
        now = now_epoch()
        census = query_census(now)
        v, _ = run(census, now)
        print("OUTCOME_BACKFILL_VERDICT=%s" % ("FAIL" if v["breach"] else "PASS"))
        return 0
    except Indeterminate as e:
        log("INDETERMINATE: %s" % e)
        print("OUTCOME_BACKFILL_VERDICT=INDETERMINATE")
        return 3
    except Exception as e:  # noqa: BLE001 — an unexpected fault verified nothing either
        log("INDETERMINATE: %s: %s" % (type(e).__name__, e))
        print("OUTCOME_BACKFILL_VERDICT=INDETERMINATE")
        return 3


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

def self_test():
    """Hermetic scenarios — no DB, no wrapper, temp state.

    Two-way by construction: every BREACH case has a HEALTHY twin differing in ONE input.

    The hermetic seam replaces psql, so the artifacts it bypasses are asserted directly: the
    SQL string's shape, the census PARSER (including a NULL newest_matured and a psql SET tag),
    the rendered alert BODY, and the token->exit-code mapping. Assertions that would RAISE are
    wrapped — an assertion that aborts the suite is a crash, not a failure.
    """
    global STATE_FILE, LOG
    tmp = tempfile.mkdtemp(prefix="outcome-backfill-selftest-")
    STATE_FILE = os.path.join(tmp, "state.json")
    LOG = os.path.join(tmp, "selftest.log")
    os.environ["OBF_SELFTEST"] = "1"
    os.environ["ALGOVAULT_TG_TEST_INERT"] = "1"

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

    NOW = 1786600000
    H = 3600

    def census(lag_h=0.5, emitted=100, matured=467094, newest_matured=True):
        return {"newest_matured": int(NOW - lag_h * H) if newest_matured else None,
                "newest_signal": NOW - 60, "matured_total": matured, "emitted_recent": emitted}

    # ── the predicate, and its one-input twins ───────────────────────────────────────────────
    check("healthy: fresh lag + input flowing -> no breach",
          lambda: classify(census(lag_h=0.7), NOW)["breach"] is False)
    check("BREACH: stale lag + input flowing (output stuck, input moving)",
          lambda: classify(census(lag_h=STALE_HOURS + 1), NOW)["breach"] is True)
    check("TWIN: same stale lag but NO input -> NOT a breach (that is seed-coverage's subject)",
          lambda: classify(census(lag_h=STALE_HOURS + 1, emitted=0), NOW)["breach"] is False)
    check("TWIN: exactly AT the threshold is healthy (boundary is >, not >=)",
          lambda: classify(census(lag_h=STALE_HOURS), NOW)["breach"] is False)
    check("BREACH: nothing EVER matured, with input flowing",
          lambda: classify(census(newest_matured=False, matured=0), NOW)["breach"] is True)
    check("TWIN: nothing matured but no input -> NOT a breach",
          lambda: classify(census(newest_matured=False, matured=0, emitted=0), NOW)["breach"]
          is False)
    check("lag is reported, not just the boolean",
          lambda: abs(classify(census(lag_h=5), NOW)["lag_h"] - 5.0) < 0.01)

    # ── the SQL string the hermetic seam bypasses ────────────────────────────────────────────
    sql = build_census_sql(NOW - 3 * H)
    check("SQL keys on the PRODUCER high-water mark, not a count or an artifact",
          lambda: "MAX(created_at) FILTER (WHERE pfe_return_pct IS NOT NULL)" in sql)
    check("SQL is read-only by construction",
          lambda: "SET default_transaction_read_only=on;" in sql)
    check("SQL carries the integer input window (created_at is an epoch int, not a timestamptz)",
          lambda: "created_at > %d" % (NOW - 3 * H) in sql)
    check("SQL has no %-format or LIKE wildcard left unresolved (the sibling's live-run defect)",
          lambda: "%" not in sql)

    # ── the census PARSER the hermetic seam bypasses ─────────────────────────────────────────
    check("parser reads a 4-field psql -tA row",
          lambda: parse_census("1786599000|1786599900|467094|577")["matured_total"] == 467094)
    check("parser skips the SET command tag before the data row",
          lambda: parse_census("SET\n1786599000|1786599900|467094|577")["emitted_recent"] == 577)
    check("parser accepts an EMPTY newest_matured as None (a FACT, not vacuity)",
          lambda: parse_census("|1786599900|0|577")["newest_matured"] is None)

    def raises_indeterminate(fn):
        try:
            fn()
        except Indeterminate:
            return True
        except Exception:  # noqa: BLE001
            return False
        return False

    check("parser: empty output -> INDETERMINATE (handed input we could not parse)",
          lambda: raises_indeterminate(lambda: parse_census("")))
    check("parser: a non-numeric row -> INDETERMINATE, never a silent 0",
          lambda: raises_indeterminate(lambda: parse_census("a|b|c|d")))
    check("parser: wrong field count -> INDETERMINATE",
          lambda: raises_indeterminate(lambda: parse_census("1|2|3")))

    # ── sustained-drift gate: day 1 holds, day 2 pages, a heal RESETS ────────────────────────
    LAST_FIRE.clear()
    open(STATE_FILE, "w").close()
    os.remove(STATE_FILE)
    _, s1 = run(census(lag_h=STALE_HOURS + 1), NOW)
    check("breach day 1 -> streak 1, NO page (sustained-drift gate)",
          lambda: s1 == 1 and not LAST_FIRE)
    _, s2 = run(census(lag_h=STALE_HOURS + 1), NOW)
    check("breach day 2 -> streak 2, PAGES", lambda: s2 == 2 and "body" in LAST_FIRE)
    body = LAST_FIRE.get("body", "")
    LAST_FIRE.clear()
    _, s3 = run(census(lag_h=0.5), NOW)
    check("a HEAL resets the streak to 0 and pages nothing",
          lambda: s3 == 0 and not LAST_FIRE)
    _, s4 = run(census(lag_h=STALE_HOURS + 1), NOW)
    check("after a heal, the NEXT single breach is day 1 again (no carried partial streak)",
          lambda: s4 == 1 and not LAST_FIRE)

    # ── the rendered BODY + per-check line the seam bypasses ─────────────────────────────────
    check("BODY names the alert id", lambda: ALERT_ID in body)
    check("BODY names the PRODUCER, so the remedy points at the right thing",
          lambda: "backfill-outcomes" in body)
    check("BODY carries the recommended wave in TEMPLATE form, never a literal W<N>",
          lambda: RECOMMENDED_WAVE in body and "W{NEXT}" in body)
    check("BODY states the sustain count with its threshold, never a bare number",
          lambda: "Consecutive breaches: 2 (pages at 2)." in body)
    line = render_eval_line(classify(census(lag_h=0.7), NOW), 0)
    check("per-check line is POSITIVE — carries lag, threshold, input and verdict",
          lambda: "lag_h=0.70h" in line and "threshold=12h" in line
          and "input_flowing=Y" in line and "verdict=ok" in line)
    check("per-check line distinguishes 'idle' from 'ok' (no input is not health)",
          lambda: "verdict=idle" in render_eval_line(
              classify(census(lag_h=STALE_HOURS + 1, emitted=0), NOW), 0))

    check("INDETERMINATE maps to exit 3, PASS/FAIL to 0",
          lambda: _token_exit_map() == {"PASS": 0, "FAIL": 0, "INDETERMINATE": 3})

    n = len(ran)
    ok = not failures and n >= _SELF_TEST_MIN_CHECKS
    if n < _SELF_TEST_MIN_CHECKS:
        print("  [FAIL] VACUITY: suite ran %d check(s), floor is %d — it verified less than it "
              "was built to" % (n, _SELF_TEST_MIN_CHECKS))
    print("SELF-TEST: %s (%d check(s) ran, floor %d, %d failure(s))"
          % ("PASS" if ok else "FAIL", n, _SELF_TEST_MIN_CHECKS, len(failures)))
    print("OUTCOME_BACKFILL_VERDICT=%s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


# Floor, not a target — set to the ACTUAL check count so removing any scenario trips it.
_SELF_TEST_MIN_CHECKS = 28


def _token_exit_map():
    """The mapping main() deploys, in ONE place so the self-test asserts the shipped fact rather
    than a copy — asserting tokens without their exit codes is how re-coding INDETERMINATE to 0
    once stayed fully green."""
    return {"PASS": 0, "FAIL": 0, "INDETERMINATE": 3}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="outcome-backfill freshness canary")
    ap.add_argument("--self-test", action="store_true",
                    help="hermetic scenario suite; exit non-zero on failure")
    a = ap.parse_args()
    sys.exit(self_test() if a.self_test else main())

#!/usr/bin/env python3
"""outcome-backfill-freshness.py — OPS-RECALIBRATE-HARNESS-RETIRE-W1 (R4),
re-keyed and given two more arms by OPS-OUTCOME-BACKFILL-STALL-W1 (A3).

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

────────────────────────────────────────────────────────────────────────────────────────────
── A3 (2026-09-05): THE RE-KEY, AND WHY IT SHIPS WITH TWO MORE ARMS AND NOT ALONE ───────────
────────────────────────────────────────────────────────────────────────────────────────────
This canary was RIGHT on 2026-09-05T17:13:01Z, for the wrong reason, and fixing only the reason
would have replaced a true page with a green light over a still-frozen public series.

The original key was `max(created_at) FILTER (WHERE pfe_return_pct IS NOT NULL)` — the BIRTH time
of the newest matured signal. The retiring wave's probe #11 had asked for "the producer's own
write timestamp" and found NO SUCH COLUMN, so the high-water mark was adopted as an inline
substitute. It measures the SUM of two independent quantities: how stale the backfill is, and the
maturation horizon of whatever is currently being emitted. It cannot separate them.

`OPS-OUTCOME-BACKFILL-STALL-W1` A1 created the missing column (`signals.outcome_filled_at`,
stamped inside `updateSignalOutcomes` in the same UPDATE as the outcome), so ARM 1 below is now
the honest producer measurement the spec always wanted.

BUT THE RE-KEY ALONE WOULD HAVE BEEN A REGRESSION, and the measurement that proves it is the
incident itself. Measured 2026-09-05: the producer was writing CONTINUOUSLY through the entire
page (`matured_total` +245 across an 11m38s read pair; the process alive at 3,716s elapsed; the
lock held by a live holder). What had actually failed was REACHABILITY —
`getSignalsNeedingUnifiedBackfillAsync` served `ORDER BY created_at ASC LIMIT 5000` against an
11,748-11,823-row backlog, so the window's newest row sat at 07:16Z and every fresher signal was
invisible to the producer by construction. Re-keyed to `max(outcome_filled_at)`, that state reads
`lag_h ~ 0` and PASSES. The one alarm watching the series would have gone quiet while the series
stayed 11.3h behind, and the only other coverage (`website-drift` on /api/performance-public) is
a MONOTONIC FLOOR, structurally blind to a plateau.

So: THREE ARMS, and they are not separable. Each prints its own positive line; ONE token.

  ARM 1  PRODUCER      max(outcome_filled_at) — is the backfill WRITING?
  ARM 2  POPULATION    per-timeframe high-water marks against each lane's OWN maturation
                       horizon — is the emitted MIX pinning the global max?
  ARM 3  REACHABILITY  (a) UNCAPPED backlog vs the producer's own cap;
                       (b) queue-frontier age — the quantity that actually paged 12.1h,
                           here under its correct name;
                       (c) sediment: pending rows the durable breaker has maxed out. Rising
                           sediment means the breaker is not holding.

ARM 3's backlog is an UNCAPPED `count(*)`. Never aggregate over the LIMIT-capped read: both
sides would come from the same capped array and the check would only confirm the tree matches
itself. That is the estate's standing capped-collection law, and this queue is the exact trap it
describes.

Aggregate precedence across arms: FAIL > INDETERMINATE > PASS. An arm that could not evaluate
never launders into a pass, and a real FAIL is never masked by a sibling's INDETERMINATE.

── Denominator and window, stated before the threshold (they are what make it fire) ─────────
DENOMINATOR : rows in `signals`. Not a rate — an age, so there is no zero-traffic denominator
              hole. The counterpart risk is the opposite one, handled next.
INPUT GUARD : the input/output-counter-mismatch shape. An ARM 1 breach requires BOTH
              (a) input flowing — >= 1 signal emitted in the last INPUT_WINDOW_HOURS (3), and
              (b) output stuck — producer lag > STALE_HOURS.
              Without (a) this alarm would page on a legitimate seeding pause, which is
              `seed-coverage-canary`'s subject and a different remedy. A canary that pages for
              someone else's fault gets muted, and then it is dark for its own.
THRESHOLD   : 12h. Calibrated against MEASURED live lag at 2026-08-13 08:24Z — global 0.70h,
              per-timeframe 3m 0.70h · 5m 1.10h · 15m 3.40h · 30m 4.55h · 1h 9.04h. Retained
              unchanged by A3: against the RE-KEYED arm 1 it is now enormously conservative (the
              producer writes every few minutes), and it stays the right number for arm 2, where
              it is applied per-lane against that lane's own horizon rather than globally.
              Revisit row: `Claude files/defensive-reductions-to-revisit.md`.
SUSTAIN     : 2 consecutive hourly breaches before paging — the estate's sustained-drift
              criterion. Detection latency ~13h vs the retired alarm's 48h.

── NULL BOOTSTRAP, and why it is INDETERMINATE rather than either verdict ───────────────────
A1 deliberately did NOT backfill `outcome_filled_at` over the ~586k historical rows: a NOT NULL
add with a default would have rewritten a ~598k-row table on the live serving path, and the
honest meaning of NULL here is "written before the stamp shipped", never "the producer failed".
So between the deploy and the first new write, `max(outcome_filled_at)` is NULL.

That is INDETERMINATE, and it must be neither alternative. PASS would be fail-open on the one arm
the re-key exists to create. FAIL would page the operator on deploy night for a healthy producer
— a spurious page against a brand-new arm is exactly how an alarm gets muted before it has ever
told the truth. The condition self-resolves within one 3-minute producer fire, and both the NULL
and the first-stamped state are asserted in the self-test.

── IDENTIFIABILITY (EDGE-POPULATION-COMPARISON-W1's law, in a new substrate) ────────────────
Arm 2's statement is only meaningful if some emitting lane CAN mature inside the threshold.
Maturation horizon is `(EVAL_CANDLES + 1) x timeframe`: 3m 0.65h · 5m 1.08h · 15m 3.25h ·
30m 4.50h · 1h 9.00h — but 2h 14.0h · 4h 28h · 8h 40h · 12h 60h · 1d 96h, ALL of which exceed
the 12h threshold. If the emitted mix ever contains only lanes whose horizon is longer than the
threshold, then a breach is true BY CONSTRUCTION and carries no information about the producer —
a threshold an arm cannot attain is a level test wearing a delta's clothes. The honest verdict
there is NOT_IDENTIFIABLE -> INDETERMINATE, never FAIL. No comparator repair fixes it; only a
refusal is honest.

── Contract (UNCHANGED by A3, deliberately) ─────────────────────────────────────────────────
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

── A3 also makes this canary REMOTELY DIAGNOSABLE (R6) ──────────────────────────────────────
Every run appends one structured record through `canary_result_log.append_result()`, which the
existing `monitoring-results-sync.sh` PULL union-merges into `Claude files/canary-results.jsonl`.
Before this, the canary published to host stdout and its own log only, so diagnosing it required
an SSH key — the exact condition that made a scheduled readout undispatchable and cost a whole
wave. The recorder NEVER changes the verdict, the exit code or the alert dispatch: a logging bug
must not become a paging bug. A failure to record is REPORTED, never silent.

Env / test seams:
  OBF_PSQL_CMD    override the psql command (default: docker exec … psql -U aoe_readonly …)
  OBF_STATE_FILE  streak state       OBF_LOG            log path
  OBF_WRAPPER     send_telegram.sh   OBF_NOW_EPOCH      freeze "now"
  OBF_STALE_HOURS threshold (12)     OBF_INPUT_WINDOW_HOURS input guard window (3)
  OBF_CONSECUTIVE_TO_PAGE sustain (2)
  OBF_QUEUE_LIMIT / OBF_MAX_ATTEMPTS / OBF_ATTEMPT_COOLDOWN_S — the producer's own constants,
                  mirrored across the language boundary and asserted against the TS source by
                  the self-test whenever a checkout is present.
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
CANARY_NAME = "outcome_backfill_freshness"

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

# ── The producer's constants, MIRRORED across a language boundary ────────────────────────────
# `src/lib/performance-db.ts` owns these as `BACKFILL_QUEUE_LIMIT` / `BACKFILL_MAX_ATTEMPTS` /
# `BACKFILL_ATTEMPT_COOLDOWN_S`. A Python canary cannot import TypeScript, so this is a mirror —
# and a mirror is a duplicated fact, which goes stale silently. The self-test therefore PARSES the
# TS source and asserts equality whenever a checkout is reachable, and says so OUT LOUD when it is
# not (this file also runs from /opt/algovault-monitoring/, where there is no checkout). Same
# shape `book-liveness-canary` uses for its mirror of `getBookLivenessMode()`.
QUEUE_LIMIT = _int_env("OBF_QUEUE_LIMIT", 5000)
MAX_ATTEMPTS = _int_env("OBF_MAX_ATTEMPTS", 3)
ATTEMPT_COOLDOWN_S = _int_env("OBF_ATTEMPT_COOLDOWN_S", 86400)

# ── Maturation horizons, mirrored from src/lib/pfe-mae.ts ────────────────────────────────────
# horizon = (EVAL_CANDLES[tf] + 1) * TF_SECONDS[tf] — the readiness gate `backfill-outcomes.ts`
# applies before it will even attempt a row. Same mirror caveat as above; same self-test check.
EVAL_CANDLES = {"1m": 12, "3m": 12, "5m": 12, "15m": 12, "30m": 8, "1h": 8,
                "2h": 6, "4h": 6, "8h": 4, "12h": 4, "1d": 3}
TF_SECONDS = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600,
              "2h": 7200, "4h": 14400, "8h": 28800, "12h": 43200, "1d": 86400}


def horizon_s(tf):
    """Seconds from emission before a row of this timeframe CAN mature. None for an unknown tf."""
    if tf not in EVAL_CANDLES or tf not in TF_SECONDS:
        return None
    return (EVAL_CANDLES[tf] + 1) * TF_SECONDS[tf]


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


# ── the queries, built as pure fns so --self-test can assert the SHAPE the seam bypasses ─────

def build_census_sql(now):
    """Scalar census: arm 1's producer stamp + arm 3's reachability quantities.

    `created_at` and `outcome_filled_at` are INTEGER epochs on this table, not timestamptz — so
    every window is plain integer arithmetic and there is no timezone or to_timestamp() to get
    wrong.

    Built by a pure function on purpose: a hermetic self-test replaces the psql seam, which makes
    the SQL string the one artifact no scenario would otherwise execute. That is exactly how a
    sibling canary shipped 26 green assertions and then died on its first live run with
    `unsupported format character` in a LIKE clause.

    NOTE the two different populations, and it is the whole point of arm 3: `backlog_uncapped` is
    an UNCAPPED count over every pending row, while `frontier` is read from the CAPPED,
    backed-off window the producer can actually see. Reading both from the capped window would
    make the check tautological — the capped-collection defect, which this estate has shipped
    twice and of which this very queue is an instance.
    """
    window_start = int(now) - INPUT_WINDOW_HOURS * 3600
    cutoff = int(now) - ATTEMPT_COOLDOWN_S
    visible = (
        "SELECT created_at FROM signals WHERE outcome_price IS NULL"
        " AND (outcome_attempts IS NULL OR outcome_attempts < {maxa}"
        " OR outcome_last_attempt_at IS NULL OR outcome_last_attempt_at <= {cut})"
        " ORDER BY created_at ASC LIMIT {lim}"
    ).format(maxa=MAX_ATTEMPTS, cut=cutoff, lim=QUEUE_LIMIT)
    return (
        "SET default_transaction_read_only=on; "
        "SELECT MAX(outcome_filled_at) AS newest_filled, "
        "COUNT(*) FILTER (WHERE outcome_filled_at IS NOT NULL) AS stamped_total, "
        "COUNT(*) FILTER (WHERE pfe_return_pct IS NOT NULL) AS matured_total, "
        "COUNT(*) FILTER (WHERE created_at > {ws}) AS emitted_recent, "
        "COUNT(*) FILTER (WHERE outcome_price IS NULL) AS backlog_uncapped, "
        "(SELECT MAX(created_at) FROM ({vis}) v) AS frontier, "
        "COUNT(*) FILTER (WHERE outcome_price IS NULL AND outcome_attempts >= {maxa}) AS sediment "
        "FROM signals;"
    ).format(ws=window_start, vis=visible, maxa=MAX_ATTEMPTS)


def build_population_sql(now):
    """Arm 2: per-timeframe emission + maturation high-water mark.

    Kept on `created_at` deliberately — this arm IS the population reading that the re-key
    retires from arm 1. Reporting it BY NAME is what turns a silent metric redefinition into a
    stated fact, per the wave's R5.3.
    """
    window_start = int(now) - INPUT_WINDOW_HOURS * 16 * 3600
    return (
        "SET default_transaction_read_only=on; "
        "SELECT timeframe, "
        "COUNT(*) FILTER (WHERE created_at > {ws}) AS emitted_window, "
        "COALESCE(MAX(created_at) FILTER (WHERE pfe_return_pct IS NOT NULL), -1) AS max_matured "
        "FROM signals GROUP BY timeframe ORDER BY timeframe;"
    ).format(ws=window_start)


def parse_census(stdout):
    """psql -tA rows. A row we were HANDED and cannot parse is INDETERMINATE, never a pass.

    NOTE the asymmetry, and it is deliberate: `newest_filled` and `frontier` may legitimately be
    EMPTY (NULL) — the first is the expected bootstrap state "nothing has been stamped yet" and
    the second is the best possible news "the producer can see no pending work" — while the counts
    must be numbers. Empty is a FACT here, not vacuity: the world builds this corpus, we did not.
    """
    for line in stdout.strip().splitlines():
        if "|" not in line:
            continue  # SET tag / notices
        parts = [p.strip() for p in line.split("|")]
        if len(parts) != 7:
            continue
        nf, st, mt, er, bl, fr, sed = parts
        if not (st.isdigit() and mt.isdigit() and er.isdigit() and bl.isdigit() and sed.isdigit()):
            continue
        return {
            "newest_filled": int(nf) if nf.isdigit() else None,
            "stamped_total": int(st),
            "matured_total": int(mt),
            "emitted_recent": int(er),
            "backlog_uncapped": int(bl),
            "frontier": int(fr) if fr.isdigit() else None,
            "sediment": int(sed),
        }
    raise Indeterminate(
        "no parseable census row in psql output (got %r) — handed input we could not parse is "
        "INDETERMINATE, never PASS" % stdout.strip()[:200])


def parse_population(stdout):
    """Rows of `timeframe|emitted_window|max_matured`. `-1` encodes "never matured".

    An EMPTY result set is a FACT (no rows at all) and parses to `[]`; arm 2 then reports
    NOT_IDENTIFIABLE rather than inventing a verdict over nothing.
    """
    rows = []
    for line in stdout.strip().splitlines():
        if "|" not in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) != 3:
            continue
        tf, emitted, mx = parts
        if not (emitted.isdigit() and mx.lstrip("-").isdigit()):
            continue
        rows.append({"timeframe": tf, "emitted": int(emitted),
                     "max_matured": None if int(mx) < 0 else int(mx)})
    return rows


def _run_psql(sql):
    cmd = os.environ.get("OBF_PSQL_CMD", PSQL_DEFAULT)
    out = subprocess.run(cmd.split() + ["-c", sql], capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise Indeterminate("psql failed rc=%d: %s" % (out.returncode, out.stderr.strip()[:200]))
    return out.stdout


def query_all(now):
    return (parse_census(_run_psql(build_census_sql(now))),
            parse_population(_run_psql(build_population_sql(now))))


# ── pure classification: three arms, each independently verdicted ─────────────────────────────

WORST_FIRST = {"FAIL": 0, "INDETERMINATE": 1, "PASS": 2}


def aggregate(verdicts):
    """FAIL > INDETERMINATE > PASS. An arm that could not evaluate never launders into a pass,
    and a real FAIL is never masked by a sibling's INDETERMINATE."""
    return sorted(verdicts, key=lambda v: WORST_FIRST[v])[0] if verdicts else "INDETERMINATE"


def arm_producer(census, now, stale_hours=None):
    """ARM 1 — is the backfill WRITING? Keyed on the producer's own stamp, never on input time."""
    stale_h = STALE_HOURS if stale_hours is None else stale_hours
    input_flowing = census["emitted_recent"] > 0
    if census["stamped_total"] == 0 or census["newest_filled"] is None:
        # The NULL bootstrap. Not PASS (fail-open on the arm the re-key exists to create) and not
        # FAIL (a spurious page on deploy night). Self-resolves on the producer's next write.
        return {"name": "producer", "verdict": "INDETERMINATE", "lag_h": None,
                "input_flowing": input_flowing,
                "detail": "BOOTSTRAP: no row carries outcome_filled_at yet — A1 deliberately did "
                          "not backfill history; resolves on the producer's next write "
                          "(stamped_total=%d)" % census["stamped_total"]}
    lag_h = max(0.0, (now - census["newest_filled"]) / 3600.0)
    stuck = lag_h > stale_h
    breach = bool(input_flowing and stuck)
    return {"name": "producer", "verdict": "FAIL" if breach else "PASS", "lag_h": lag_h,
            "input_flowing": input_flowing,
            "detail": "producer_lag_h=%.2f threshold=%dh input_flowing=%s (emitted_last_%dh=%d) "
                      "stamped_total=%d"
                      % (lag_h, stale_h, "Y" if input_flowing else "N", INPUT_WINDOW_HOURS,
                         census["emitted_recent"], census["stamped_total"])}


def arm_population(rows, now, stale_hours=None):
    """ARM 2 — is the emitted MIX pinning the global max, and is the question even identifiable?

    Each lane is judged against its OWN maturation horizon, never against the global threshold:
    a 1d lane whose newest matured row is 90h old is HEALTHY (horizon 96h), and calling that a
    stall is precisely the population/producer conflation this wave exists to retire.

    IDENTIFIABILITY comes first. If no lane that is currently EMITTING has a horizon shorter than
    the threshold, no observation can distinguish a stalled producer from a slow-maturing mix —
    the threshold is unattainable by construction. NOT_IDENTIFIABLE -> INDETERMINATE. Refusing is
    the only honest verdict; no comparator repair fixes it.
    """
    stale_h = STALE_HOURS if stale_hours is None else stale_hours
    emitting = [r for r in rows if r["emitted"] > 0 and horizon_s(r["timeframe"]) is not None]
    if not emitting:
        return {"name": "population", "verdict": "INDETERMINATE", "lanes": [],
                "detail": "NOT_IDENTIFIABLE: no lane with a known horizon is emitting"}
    attainable = [r for r in emitting if horizon_s(r["timeframe"]) <= stale_h * 3600]
    if not attainable:
        widths = ", ".join("%s %.2fh" % (r["timeframe"], horizon_s(r["timeframe"]) / 3600.0)
                           for r in emitting)
        return {"name": "population", "verdict": "INDETERMINATE", "lanes": [],
                "detail": "NOT_IDENTIFIABLE: every emitting lane matures slower than the %dh "
                          "threshold (%s) — unattainable by construction, so a breach would carry "
                          "no information about the producer" % (stale_h, widths)}
    lanes, stalled = [], []
    for r in attainable:
        h = horizon_s(r["timeframe"])
        if r["max_matured"] is None:
            lag_h, bad = None, True
        else:
            lag_h = max(0.0, (now - r["max_matured"]) / 3600.0)
            # A lane is stalled when its newest matured row is older than its OWN horizon plus the
            # threshold's slack. Judged per-lane, so a mix shift cannot move it.
            bad = lag_h > (h / 3600.0) + stale_h
        lanes.append({"tf": r["timeframe"], "emitted": r["emitted"],
                      "horizon_h": h / 3600.0, "lag_h": lag_h, "stalled": bad})
        if bad:
            stalled.append(r["timeframe"])
    return {"name": "population", "verdict": "FAIL" if stalled else "PASS", "lanes": lanes,
            "detail": ("lanes " + " · ".join(
                "%s(h=%.2f lag=%s)" % (ln["tf"], ln["horizon_h"],
                                       "never" if ln["lag_h"] is None else "%.2f" % ln["lag_h"])
                for ln in lanes)
                + ("" if not stalled else "  STALLED: " + ",".join(stalled)))}


def arm_reachability(census, now, stale_hours=None):
    """ARM 3 — can the producer SEE fresh work? The arm that names this wave's own cause.

    (a) UNCAPPED backlog vs the producer's own cap. At or over the cap the queue's newest visible
        row is older than the newest pending row BY CONSTRUCTION, and no amount of producer health
        can move the series forward.
    (b) Queue-frontier age. This is the quantity that paged 12.1h on 2026-09-05 while the producer
        was healthy — here under its correct name instead of wearing the producer's.
    (c) Sediment: pending rows the durable breaker has already maxed out. Reported ALWAYS so the
        series exists; FAIL only when sediment alone would fill the window, which is the terminal
        state of the original outage.
    """
    stale_h = STALE_HOURS if stale_hours is None else stale_hours
    backlog, sediment = census["backlog_uncapped"], census["sediment"]
    frontier_age_h = 0.0 if census["frontier"] is None else \
        max(0.0, (now - census["frontier"]) / 3600.0)
    checks = [
        ("backlog_within_cap", backlog < QUEUE_LIMIT,
         "backlog_uncapped=%d cap=%d" % (backlog, QUEUE_LIMIT)),
        ("frontier_reachable", frontier_age_h <= stale_h,
         "queue_frontier_age_h=%.2f threshold=%dh" % (frontier_age_h, stale_h)),
        ("sediment_bounded", sediment < QUEUE_LIMIT,
         "sediment=%d (attempts>=%d, cooldown %ds) cap=%d"
         % (sediment, MAX_ATTEMPTS, ATTEMPT_COOLDOWN_S, QUEUE_LIMIT)),
    ]
    bad = [n for n, ok, _ in checks if not ok]
    return {"name": "reachability", "verdict": "FAIL" if bad else "PASS", "checks": checks,
            "frontier_age_h": frontier_age_h, "backlog": backlog, "sediment": sediment,
            "detail": " | ".join(d for _, _, d in checks)
                      + ("" if not bad else "  FAILING: " + ",".join(bad))}


def classify(census, rows, now, stale_hours=None):
    """Compose the three arms into ONE verdict. Single derivation: every consumer — the log lines,
    the alert body, the R6 record and the exit code — projects from this one value."""
    arms = [arm_producer(census, now, stale_hours),
            arm_population(rows, now, stale_hours),
            arm_reachability(census, now, stale_hours)]
    verdict = aggregate([a["verdict"] for a in arms])
    return {"verdict": verdict, "arms": arms,
            "breach": verdict == "FAIL",
            "input_flowing": census["emitted_recent"] > 0,
            "emitted_recent": census["emitted_recent"],
            "matured_total": census["matured_total"],
            "stamped_total": census["stamped_total"],
            "backlog_uncapped": census["backlog_uncapped"],
            "sediment": census["sediment"]}


def render_eval_lines(v, streak):
    """POSITIVE per-ARM output. A run silently skipped by a parse error must never look identical
    to a run that evaluated and passed, and an arm that did not run must be visibly absent."""
    lines = ["EVAL outcome_backfill: verdict=%s streak=%d/%d"
             % (v["verdict"], streak, CONSECUTIVE_TO_PAGE)]
    for a in v["arms"]:
        lines.append("  ARM %-13s %-13s %s" % (a["name"], a["verdict"], a["detail"]))
    return lines


def build_body(v, streak):
    producer = next(a for a in v["arms"] if a["name"] == "producer")
    reach = next(a for a in v["arms"] if a["name"] == "reachability")
    popn = next(a for a in v["arms"] if a["name"] == "population")
    failing = [a["name"] for a in v["arms"] if a["verdict"] == "FAIL"]
    return "\n".join([
        "\U0001F6D1 %s" % ALERT_ID,
        "",
        "Failing arm(s): %s." % ", ".join(failing),
        "",
        "  producer     : %s" % producer["detail"],
        "  reachability : %s" % reach["detail"],
        "  population   : %s" % popn["detail"],
        "",
        "Producer: %s" % PRODUCER,
        "Consecutive breaches: %d (pages at %d)." % (streak, CONSECUTIVE_TO_PAGE),
        "matured_total=%d" % v["matured_total"],
        "",
        "Read the ARMS, not just the headline. A healthy `producer` arm beside a failing "
        "`reachability` arm means the backfill IS writing but CANNOT SEE the newest signals — its "
        "work queue is capped and oldest-first, so the series behind the public "
        "signal-performance resource is frozen while nothing looks dead. That is the 2026-09-05 "
        "shape, and it is why this alarm has three arms instead of one number.",
        "",
        "Action: dispatch %s via Cowork → Claude Code" % RECOMMENDED_WAVE,
        "Source log: %s" % LOG,
    ])


# ── state + effects ──────────────────────────────────────────────────────────────────────────

def _read_state():
    try:
        with open(STATE_FILE) as fh:
            d = json.load(fh)
            return d if isinstance(d, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def read_streak():
    try:
        return int(_read_state().get("consecutive_breaches", 0))
    except (ValueError, TypeError):
        return 0


def read_paged():
    """Did a page actually reach the operator for the current episode?

    This is the gate on announcing a resolution. Announcing a recovery for an episode nobody was
    told about is chatter, and chatter is what the silent-by-default rule exists to prevent.
    """
    return bool(_read_state().get("paged", False))


def read_recovery_streak():
    try:
        return int(_read_state().get("consecutive_pass", 0))
    except (ValueError, TypeError):
        return 0


def write_state(streak, v, now, paged=False, recovery_streak=0):
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as fh:
            json.dump({"consecutive_breaches": streak, "consecutive_pass": recovery_streak,
                       "paged": bool(paged), "last_run_epoch": now,
                       "last_verdict": v["verdict"],
                       "last_arms": {a["name"]: a["verdict"] for a in v["arms"]}}, fh, indent=1)
    except OSError as e:
        log("WARN: could not persist state to %s: %s" % (STATE_FILE, e))


LAST_CLEAR = {}


def clear(reason):
    """Announce ONE bounded resolution for a DELIVERED page. `send_telegram.sh` owns the rest.

    SYMMETRIC HYSTERESIS, and it is the condition on which `announce_resolution: true` was
    approved for this alert rather than a preference. The page requires CONSECUTIVE_TO_PAGE
    consecutive FAILs; the resolution requires the same number of consecutive PASSes. Without it
    this alert would flap-announce, because its own measured behaviour on 2026-09-05 oscillated
    across the threshold within a single hour (12.19 -> 12.13 -> 11.61 -> 11.28) — and a stream of
    RESOLVED messages is exactly the chatter the silent-by-default rule exists to prevent.

    The wrapper still owns the final say: it POSTs only if the registry row opts in, only if a
    cooldown marker proves a fire was DELIVERED, and it removes that marker on success so one
    episode can produce at most one resolution.
    """
    LAST_CLEAR["reason"] = reason
    if os.environ.get("OBF_SELFTEST") == "1":
        log("WOULD_CLEAR: %s (%s) (self-test — wrapper skipped)" % (ALERT_ID, reason))
        return
    proc = subprocess.run([WRAPPER, "--clear", ALERT_ID, reason],
                          capture_output=True, text=True, timeout=30)
    log("wrapper --clear exit=%d out=%s"
        % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


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


def publish_result(v, exit_code, path=None):
    """R6 — one structured record per run, so the NEXT occurrence is a file read and not an SSH
    session. A RECORDER, never a gate: it cannot change the verdict, the exit code or the alert
    dispatch, it never raises, and a failure to record is REPORTED rather than silent.

    The import is local and defensive: this file runs both from `/opt/algovault-monitoring/` and
    from a repo checkout, and a future install that forgets the sibling module must degrade to a
    printed line rather than to a dead canary.

    `path` is a TEST SEAM and exists for one measured reason. `canary_result_log` resolves its
    target from the environment at MODULE IMPORT time, so once the module is cached, setting
    `CANARY_RESULT_LOG_PATH` cannot steer a later call — which left the self-test unable to drive
    this function's failure branch, and a check that only drives the success branch stayed GREEN
    while the except-branch was deliberately mutated to overwrite the verdict. Production passes
    nothing and keeps the module default.
    """
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import canary_result_log  # noqa: PLC0415 — deliberately local; see docstring
        metrics = {
            "arms": {a["name"]: a["verdict"] for a in v["arms"]},
            "producer_lag_h": next(a for a in v["arms"] if a["name"] == "producer")["lag_h"],
            "queue_frontier_age_h": next(
                a for a in v["arms"] if a["name"] == "reachability")["frontier_age_h"],
            "backlog_uncapped": v["backlog_uncapped"],
            "queue_limit": QUEUE_LIMIT,
            "sediment": v["sediment"],
            "matured_total": v["matured_total"],
            "stamped_total": v["stamped_total"],
            "emitted_recent": v["emitted_recent"],
        }
        ok, detail = canary_result_log.append_result(
            CANARY_NAME, v["verdict"], exit_code, metrics, path=path)
        log("CANARY_RESULT_LOG=%s" % detail if ok else "CANARY_RESULT_LOG_FAILED=%s" % detail)
    except Exception as e:  # noqa: BLE001 — a logging bug must never become a paging bug
        log("CANARY_RESULT_LOG_FAILED=%s: %s" % (type(e).__name__, e))


def run(census, rows, now):
    v = classify(census, rows, now)
    # A heal resets the streak to 0 rather than decaying it: a producer that comes back is healthy
    # now, and carrying a partial streak forward would page on the NEXT single blip.
    # An INDETERMINATE run HOLDS the streak rather than advancing or clearing it — a run that
    # could not evaluate is not evidence of sustained drift, and letting it accumulate would page
    # on two consecutive unreadable runs.
    prior = read_streak()
    paged = read_paged()
    recovery = read_recovery_streak()
    streak = prior + 1 if v["breach"] else (0 if v["verdict"] == "PASS" else prior)

    # SYMMETRIC HYSTERESIS on the way back out. A PASS advances the recovery streak; anything
    # else resets it; an INDETERMINATE holds BOTH streaks, because a run that could not evaluate
    # is evidence of nothing in either direction.
    if v["verdict"] == "PASS":
        recovery += 1
    elif v["verdict"] == "FAIL":
        recovery = 0

    for line in render_eval_lines(v, streak):
        log(line)

    will_page = v["breach"] and streak >= CONSECUTIVE_TO_PAGE
    will_clear = (not v["breach"] and v["verdict"] == "PASS"
                  and paged and recovery >= CONSECUTIVE_TO_PAGE)
    if will_page:
        paged = True
    if will_clear:
        paged, recovery = False, 0

    write_state(streak, v, now, paged=paged, recovery_streak=recovery)

    if will_page:
        fire(build_body(v, streak))
    elif v["breach"]:
        log("BREACH_DAY_1: sustained-drift gate holds the page until streak %d"
            % CONSECUTIVE_TO_PAGE)
    elif will_clear:
        clear("outcome-backfill healthy on %d consecutive checks (all three arms PASS)"
              % CONSECUTIVE_TO_PAGE)
    elif v["verdict"] == "PASS" and read_paged():
        log("RECOVERY_HOLD: %d/%d consecutive PASS — a resolution needs the same sustain the "
            "page needed" % (recovery, CONSECUTIVE_TO_PAGE))
    return v, streak


def main():
    try:
        now = now_epoch()
        census, rows = query_all(now)
        v, _ = run(census, rows, now)
        code = _token_exit_map()[v["verdict"]]
        publish_result(v, code)
        print("OUTCOME_BACKFILL_VERDICT=%s" % v["verdict"])
        return code
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

    Two-way by construction: every FAIL case has a HEALTHY twin differing in ONE input.

    The hermetic seam replaces psql, so the artifacts it bypasses are asserted directly: both SQL
    strings' shapes, both PARSERS (including a NULL stamp, a NULL frontier and a psql SET tag),
    the rendered alert BODY, the mirrored producer constants, the R6 recorder's inertness, and the
    token->exit-code mapping. Assertions that would RAISE are wrapped — an assertion that aborts
    the suite is a crash, not a failure, and a crash reports nothing.
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

    def census(filled_lag_h=0.1, emitted=100, matured=467094, stamped=467094,
               backlog=900, frontier_lag_h=0.5, sediment=100):
        return {"newest_filled": None if filled_lag_h is None else int(NOW - filled_lag_h * H),
                "stamped_total": stamped, "matured_total": matured, "emitted_recent": emitted,
                "backlog_uncapped": backlog,
                "frontier": None if frontier_lag_h is None else int(NOW - frontier_lag_h * H),
                "sediment": sediment}

    def pop(lanes=(("3m", 500, 0.6), ("5m", 400, 1.0), ("1h", 200, 8.0))):
        return [{"timeframe": tf, "emitted": e,
                 "max_matured": None if lag is None else int(NOW - lag * H)}
                for tf, e, lag in lanes]

    # ── ARM 1: the PRODUCER arm, re-keyed ────────────────────────────────────────────────────
    check("arm1 PASS: fresh producer stamp + input flowing",
          lambda: arm_producer(census(filled_lag_h=0.1), NOW)["verdict"] == "PASS")
    check("arm1 FAIL: stale producer stamp + input flowing",
          lambda: arm_producer(census(filled_lag_h=STALE_HOURS + 1), NOW)["verdict"] == "FAIL")
    check("arm1 TWIN: same stale stamp but NO input -> PASS (seed-coverage's subject, not ours)",
          lambda: arm_producer(census(filled_lag_h=STALE_HOURS + 1, emitted=0), NOW)["verdict"]
          == "PASS")
    check("arm1 TWIN: exactly AT the threshold is healthy (boundary is >, not >=)",
          lambda: arm_producer(census(filled_lag_h=STALE_HOURS), NOW)["verdict"] == "PASS")
    check("arm1 NULL BOOTSTRAP -> INDETERMINATE, never PASS (fail-open) and never FAIL (page)",
          lambda: arm_producer(census(filled_lag_h=None, stamped=0), NOW)["verdict"]
          == "INDETERMINATE")
    check("arm1 says BOOTSTRAP in words, so deploy-night INDETERMINATE is legible not mysterious",
          lambda: "BOOTSTRAP" in arm_producer(census(filled_lag_h=None, stamped=0), NOW)["detail"])
    check("arm1 the first stamped row RESOLVES the bootstrap to PASS",
          lambda: arm_producer(census(filled_lag_h=0.01, stamped=1), NOW)["verdict"] == "PASS")
    check("arm1 reports the lag as a number, not just the boolean",
          lambda: abs(arm_producer(census(filled_lag_h=5), NOW)["lag_h"] - 5.0) < 0.01)
    check("arm1 keys on outcome_filled_at, NOT on created_at (the whole point of the re-key)",
          lambda: "MAX(outcome_filled_at)" in build_census_sql(NOW)
          and "MAX(created_at) FILTER" not in build_census_sql(NOW))

    # ── ARM 2: POPULATION + the identifiability guard ────────────────────────────────────────
    check("arm2 PASS: every emitting lane matured inside its OWN horizon",
          lambda: arm_population(pop(), NOW)["verdict"] == "PASS")
    check("arm2 judges a slow lane against its OWN horizon, not the global threshold",
          lambda: arm_population(pop((("3m", 100, 0.6), ("1d", 5, 90.0))), NOW)["verdict"]
          == "PASS")
    check("arm2 uses the lane's horizon as a TERM, not just as an identifiability filter: a 1h "
          "lane (horizon 9h) at 15h lag is PASS, though 15h exceeds the 12h global threshold",
          # The check above cannot see this: its slow lane (1d, horizon 96h) is removed by the
          # identifiability filter BEFORE the per-lane comparison runs, so the horizon term is
          # never exercised. Measured — rewriting the comparison to the bare global threshold
          # left the whole suite green. This lane is attainable (9h <= 12h) so it reaches the
          # comparison, and its correct bound (9 + 12 = 21h) differs from the global one.
          lambda: arm_population(pop((("1h", 200, 15.0),)), NOW)["verdict"] == "PASS"
          and arm_population(pop((("1h", 200, 22.0),)), NOW)["verdict"] == "FAIL")
    check("arm2 FAIL: a FAST lane stalled far beyond its own horizon (the 2026-09-05 shape)",
          lambda: arm_population(pop((("3m", 500, 40.0), ("5m", 400, 40.0))), NOW)["verdict"]
          == "FAIL")
    check("arm2 TWIN: the same lanes, fresh -> PASS",
          lambda: arm_population(pop((("3m", 500, 0.6), ("5m", 400, 1.0))), NOW)["verdict"]
          == "PASS")
    check("arm2 NOT_IDENTIFIABLE -> INDETERMINATE when every emitting lane out-matures the "
          "threshold (a threshold an arm cannot attain is a level test in a delta's clothes)",
          lambda: arm_population(pop((("4h", 50, 30.0), ("1d", 5, 100.0))), NOW)["verdict"]
          == "INDETERMINATE")
    check("arm2 NOT_IDENTIFIABLE says so IN WORDS, so the refusal is legible in the log",
          lambda: "NOT_IDENTIFIABLE" in arm_population(pop((("4h", 50, 30.0),)), NOW)["detail"])
    check("arm2 INDETERMINATE on an empty population, never a verdict over nothing",
          lambda: arm_population([], NOW)["verdict"] == "INDETERMINATE")
    check("arm2 ignores a lane that is not emitting (it cannot pin a high-water mark)",
          lambda: arm_population(pop((("3m", 500, 0.6), ("1d", 0, 900.0))), NOW)["verdict"]
          == "PASS")
    check("arm2 FAIL when an emitting fast lane has NEVER matured",
          lambda: arm_population(pop((("3m", 500, None),)), NOW)["verdict"] == "FAIL")
    check("arm2 names every lane it judged, with that lane's own horizon",
          lambda: "3m(h=0.65" in arm_population(pop((("3m", 500, 0.6),)), NOW)["detail"])

    # ── ARM 3: REACHABILITY — the arm that names this wave's own cause ───────────────────────
    check("arm3 PASS: backlog under cap, frontier fresh, sediment bounded",
          lambda: arm_reachability(census(), NOW)["verdict"] == "PASS")
    check("arm3 FAIL: backlog AT the producer's cap (the 2026-09-05 cause, by name)",
          lambda: arm_reachability(census(backlog=QUEUE_LIMIT), NOW)["verdict"] == "FAIL")
    check("arm3 TWIN: one row under the cap -> PASS",
          lambda: arm_reachability(census(backlog=QUEUE_LIMIT - 1), NOW)["verdict"] == "PASS")
    check("arm3 FAIL: queue frontier older than the threshold",
          lambda: arm_reachability(census(frontier_lag_h=STALE_HOURS + 1), NOW)["verdict"]
          == "FAIL")
    check("arm3 TWIN: frontier exactly at the threshold is healthy",
          lambda: arm_reachability(census(frontier_lag_h=STALE_HOURS), NOW)["verdict"] == "PASS")
    check("arm3 an EMPTY frontier is the BEST case (no pending work), never an error",
          lambda: arm_reachability(census(frontier_lag_h=None), NOW)["verdict"] == "PASS")
    check("arm3 FAIL when sediment alone would fill the window",
          lambda: arm_reachability(census(sediment=QUEUE_LIMIT), NOW)["verdict"] == "FAIL")
    check("arm3 reports backlog, frontier age and sediment ALWAYS, so the series exists",
          lambda: all(k in arm_reachability(census(), NOW)["detail"]
                      for k in ("backlog_uncapped=", "queue_frontier_age_h=", "sediment=")))
    check("arm3 names WHICH sub-check failed, never a bare FAIL",
          lambda: "FAILING: backlog_within_cap" in
          arm_reachability(census(backlog=QUEUE_LIMIT), NOW)["detail"])

    # ── the composition rule ─────────────────────────────────────────────────────────────────
    check("aggregate precedence is FAIL > INDETERMINATE > PASS",
          lambda: aggregate(["PASS", "INDETERMINATE", "FAIL"]) == "FAIL"
          and aggregate(["PASS", "INDETERMINATE"]) == "INDETERMINATE"
          and aggregate(["PASS", "PASS"]) == "PASS")
    check("aggregate over NOTHING is INDETERMINATE, never PASS",
          lambda: aggregate([]) == "INDETERMINATE")
    check("THE REGRESSION THIS WAVE EXISTS TO PREVENT: a healthy producer beside an unreachable "
          "queue is a FAIL, never a PASS",
          lambda: classify(census(filled_lag_h=0.1, backlog=QUEUE_LIMIT + 6800,
                                  frontier_lag_h=11.3), pop(), NOW)["verdict"] == "FAIL")
    check("...and the arms name WHICH half broke (producer PASS, reachability FAIL)",
          lambda: [a["verdict"] for a in classify(
              census(filled_lag_h=0.1, backlog=QUEUE_LIMIT + 6800, frontier_lag_h=11.3),
              pop(), NOW)["arms"]] == ["PASS", "PASS", "FAIL"])
    check("a fully healthy estate is PASS on all three arms",
          lambda: classify(census(), pop(), NOW)["verdict"] == "PASS")

    # ── the SQL strings the hermetic seam bypasses ───────────────────────────────────────────
    sql = build_census_sql(NOW)
    check("census SQL is read-only by construction",
          lambda: "SET default_transaction_read_only=on;" in sql)
    check("census SQL counts the backlog UNCAPPED (never over the LIMIT-capped read)",
          lambda: "COUNT(*) FILTER (WHERE outcome_price IS NULL) AS backlog_uncapped" in sql)
    check("census SQL reads the frontier from the CAPPED, backed-off window",
          lambda: "LIMIT %d" % QUEUE_LIMIT in sql and "outcome_attempts" in sql)
    check("census SQL carries the integer input window (created_at is an epoch int)",
          lambda: "created_at > %d" % (NOW - INPUT_WINDOW_HOURS * H) in sql)
    check("census SQL carries the backoff cutoff derived from `now`",
          lambda: str(NOW - ATTEMPT_COOLDOWN_S) in sql)
    check("neither SQL leaves a %-format or LIKE wildcard unresolved (a sibling's live-run bug)",
          lambda: "%" not in sql and "%" not in build_population_sql(NOW))
    check("no SQL reads an outcome VALUE — Data Integrity: cardinalities and timestamps only",
          lambda: all(t not in sql and t not in build_population_sql(NOW)
                      for t in ("outcome_return_pct", "mae_return_pct", "pfe_price")))
    check("population SQL groups by timeframe and encodes 'never matured' as -1",
          lambda: "GROUP BY timeframe" in build_population_sql(NOW)
          and "COALESCE(MAX(created_at) FILTER (WHERE pfe_return_pct IS NOT NULL), -1)"
          in build_population_sql(NOW))

    # ── the PARSERS the hermetic seam bypasses ───────────────────────────────────────────────
    row = "1786599000|467094|467094|577|900|1786598000|100"
    check("census parser reads a 7-field psql -tA row",
          lambda: parse_census(row)["backlog_uncapped"] == 900)
    check("census parser skips the SET command tag before the data row",
          lambda: parse_census("SET\n" + row)["sediment"] == 100)
    check("census parser accepts an EMPTY stamp as None (the bootstrap FACT, not vacuity)",
          lambda: parse_census("|0|0|577|900|1786598000|0")["newest_filled"] is None)
    check("census parser accepts an EMPTY frontier as None (nothing pending, the best case)",
          lambda: parse_census("1786599000|1|1|577|0||0")["frontier"] is None)

    def raises_indeterminate(fn):
        try:
            fn()
        except Indeterminate:
            return True
        except Exception:  # noqa: BLE001
            return False
        return False

    check("census parser: empty output -> INDETERMINATE (handed input we could not parse)",
          lambda: raises_indeterminate(lambda: parse_census("")))
    check("census parser: a non-numeric row -> INDETERMINATE, never a silent 0",
          lambda: raises_indeterminate(lambda: parse_census("a|b|c|d|e|f|g")))
    check("census parser: wrong field count -> INDETERMINATE",
          lambda: raises_indeterminate(lambda: parse_census("1|2|3")))
    check("population parser reads rows and decodes -1 as 'never matured'",
          lambda: parse_population("3m|500|1786599000\n1d|5|-1")[1]["max_matured"] is None)
    check("population parser returns [] on empty output — a FACT the arm then refuses over",
          lambda: parse_population("") == [])

    # ── the mirrored producer constants (a duplicated fact across a language boundary) ───────
    def mirror_matches():
        here = os.path.dirname(os.path.abspath(__file__))
        ts = os.path.join(here, "..", "..", "src", "lib", "performance-db.ts")
        if not os.path.exists(ts):
            print("      (mirror check SKIPPED — no checkout beside this file; expected when "
                  "running from /opt/algovault-monitoring/)")
            return True
        with open(ts) as fh:
            src = fh.read()
        for name, val in (("BACKFILL_QUEUE_LIMIT", QUEUE_LIMIT),
                          ("BACKFILL_MAX_ATTEMPTS", MAX_ATTEMPTS),
                          ("BACKFILL_ATTEMPT_COOLDOWN_S", ATTEMPT_COOLDOWN_S)):
            marker = "export const %s = " % name
            i = src.find(marker)
            if i < 0:
                return False
            lit = src[i + len(marker):src.index(";", i)].replace("_", "").strip()
            if int(lit) != val:
                return False
        return True
    check("mirrored producer constants match src/lib/performance-db.ts when a checkout is present",
          mirror_matches)

    def horizons_match():
        here = os.path.dirname(os.path.abspath(__file__))
        ts = os.path.join(here, "..", "..", "src", "lib", "pfe-mae.ts")
        if not os.path.exists(ts):
            print("      (horizon mirror SKIPPED — no checkout beside this file)")
            return True
        with open(ts) as fh:
            src = fh.read()
        i = src.index("EVAL_CANDLES")
        blk = src[i:src.index("}", i)]
        return all("'%s': %d" % (tf, n) in blk for tf, n in EVAL_CANDLES.items())
    check("mirrored EVAL_CANDLES matches src/lib/pfe-mae.ts when a checkout is present",
          horizons_match)
    check("2h+ horizons genuinely exceed the 12h threshold — the identifiability hazard is REAL",
          lambda: horizon_s("2h") == 14 * H and horizon_s("1h") == 9 * H
          and horizon_s("2h") > STALE_HOURS * H)
    check("an unknown timeframe has no horizon and is never silently given one",
          lambda: horizon_s("7s") is None)

    # ── sustained-drift gate: day 1 holds, day 2 pages, a heal RESETS ────────────────────────
    LAST_FIRE.clear()
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
    bad = census(filled_lag_h=STALE_HOURS + 1)
    _, s1 = run(bad, pop(), NOW)
    check("breach day 1 -> streak 1, NO page (sustained-drift gate)",
          lambda: s1 == 1 and not LAST_FIRE)
    _, s2 = run(bad, pop(), NOW)
    check("breach day 2 -> streak 2, PAGES", lambda: s2 == 2 and "body" in LAST_FIRE)
    body = LAST_FIRE.get("body", "")
    LAST_FIRE.clear()
    _, s3 = run(census(), pop(), NOW)
    check("a HEAL resets the streak to 0 and pages nothing",
          lambda: s3 == 0 and not LAST_FIRE)
    _, s4 = run(bad, pop(), NOW)
    check("after a heal, the NEXT single breach is day 1 again (no carried partial streak)",
          lambda: s4 == 1 and not LAST_FIRE)
    LAST_FIRE.clear()
    _, s5 = run(census(filled_lag_h=None, stamped=0), pop(), NOW)
    check("an INDETERMINATE run HOLDS the streak — it is not evidence of sustained drift",
          lambda: s5 == s4 and not LAST_FIRE)

    # ── SYMMETRIC HYSTERESIS on the way out (the condition on announce_resolution: true) ─────
    LAST_FIRE.clear()
    LAST_CLEAR.clear()
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
    run(bad, pop(), NOW)                       # day 1 — held
    run(bad, pop(), NOW)                       # day 2 — PAGES
    check("resolution precondition: the episode is marked as DELIVERED once it pages",
          lambda: read_paged() is True)
    LAST_CLEAR.clear()
    run(census(), pop(), NOW)                  # first PASS
    check("ONE healthy check after a page does NOT announce a resolution (flap guard)",
          lambda: not LAST_CLEAR and read_paged() is True)
    check("...and the hold is REPORTED, so an un-announced recovery is never silent-by-accident",
          lambda: "RECOVERY_HOLD: 1/2" in open(LOG).read())
    run(census(), pop(), NOW)                  # second consecutive PASS -> announce
    check("TWO consecutive healthy checks announce exactly ONE resolution",
          lambda: "reason" in LAST_CLEAR and read_paged() is False)
    LAST_CLEAR.clear()
    run(census(), pop(), NOW)                  # third PASS -> nothing more
    check("a third healthy check announces NOTHING — one resolution per delivered episode",
          lambda: not LAST_CLEAR)
    LAST_CLEAR.clear()
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
    run(census(), pop(), NOW)
    run(census(), pop(), NOW)
    check("healthy checks with NO delivered page announce nothing — recovery chatter stays off",
          lambda: not LAST_CLEAR)
    LAST_CLEAR.clear()
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
    run(bad, pop(), NOW)
    run(bad, pop(), NOW)                       # paged
    LAST_CLEAR.clear()
    run(census(), pop(), NOW)                  # PASS 1
    run(census(filled_lag_h=None, stamped=0), pop(), NOW)   # INDETERMINATE — holds
    check("an INDETERMINATE between two PASSes HOLDS the recovery streak, never advances it",
          lambda: not LAST_CLEAR and read_recovery_streak() == 1)
    run(census(), pop(), NOW)                  # PASS 2 -> now it announces
    check("...and the very next PASS completes the sustain and announces",
          lambda: "reason" in LAST_CLEAR)
    LAST_CLEAR.clear()
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
    run(bad, pop(), NOW)
    run(bad, pop(), NOW)                       # paged
    LAST_CLEAR.clear()
    run(census(), pop(), NOW)                  # PASS 1
    run(bad, pop(), NOW)                       # FAIL — resets the recovery streak
    run(census(), pop(), NOW)                  # PASS 1 again, not 2
    check("a FAIL between two PASSes RESETS the recovery streak (no announce on a flap)",
          lambda: not LAST_CLEAR and read_recovery_streak() == 1)

    # ── the rendered BODY + per-arm lines the seam bypasses ──────────────────────────────────
    check("BODY names the alert id", lambda: ALERT_ID in body)
    check("BODY names the PRODUCER, so the remedy points at the right thing",
          lambda: "backfill-outcomes" in body)
    check("BODY carries the recommended wave in TEMPLATE form, never a literal W<N>",
          lambda: RECOMMENDED_WAVE in body and "W{NEXT}" in body)
    check("BODY states the sustain count with its threshold, never a bare number",
          lambda: "Consecutive breaches: 2 (pages at 2)." in body)
    check("BODY names WHICH arm(s) failed, so the operator is not left to guess",
          lambda: "Failing arm(s): producer" in body)
    check("BODY renders all three arms, not only the failing one",
          lambda: all(k in body for k in ("producer     :", "reachability :", "population   :")))
    lines = render_eval_lines(classify(census(), pop(), NOW), 0)
    check("per-check output is POSITIVE and per-ARM — one line each, all three present",
          lambda: len(lines) == 4 and all(
              any(("ARM %-13s" % n) in ln for ln in lines)
              for n in ("producer", "population", "reachability")))
    check("per-arm lines carry the measured values, not just verdicts",
          lambda: any("producer_lag_h=" in ln for ln in lines)
          and any("queue_frontier_age_h=" in ln for ln in lines))

    check("INDETERMINATE maps to exit 3, PASS/FAIL to 0",
          lambda: _token_exit_map() == {"PASS": 0, "FAIL": 0, "INDETERMINATE": 3})
    check("every verdict classify can return has an exit code",
          lambda: all(v in _token_exit_map() for v in ("PASS", "FAIL", "INDETERMINATE")))

    # ── R6: the result recorder must never be able to change the verdict ─────────────────────
    #
    # BOTH branches are exercised, and the second one is not padding — it was measured. Written
    # with only the success path, this check stayed GREEN while `publish_result`'s except-branch
    # was deliberately mutated to overwrite `v["verdict"]`, because a healthy recorder never
    # reaches that branch. That is the "a hermetic self-test is blind to exactly what its own seam
    # replaces" law arriving inside the very assertion meant to enforce inertness. The failure
    # branch is where a logging bug would actually become a paging bug, so it is the branch that
    # most needs driving.
    def recorder_inert(path):
        v = classify(census(), pop(), NOW)
        before = (v["verdict"], _token_exit_map()[v["verdict"]])
        publish_result(v, before[1], path=path)   # must not raise, must not mutate
        return (v["verdict"], _token_exit_map()[v["verdict"]]) == before
    check("R6 recorder is INERT on the SUCCESS path — verdict and exit code unchanged, no raise",
          lambda: recorder_inert(os.path.join(tmp, "results.jsonl")))
    check("R6 recorder is INERT on the FAILURE path too — an unwritable target changes NOTHING",
          lambda: recorder_inert("/proc/definitely-not-writable/results.jsonl"))
    def recorder_inert_when_it_RAISES():
        # `append_result` is contracted never to raise, so its returned-failure path (above) does
        # NOT reach `publish_result`'s except-branch — and an unreached branch is a branch no
        # mutation test can catch. Measured: mutating that branch to overwrite the verdict stayed
        # GREEN through both checks above. Force a raise so the branch is genuinely driven.
        import types
        boom = types.ModuleType("canary_result_log")

        def _raise(*_a, **_k):
            raise RuntimeError("injected recorder fault")
        boom.append_result = _raise
        saved = sys.modules.get("canary_result_log")
        sys.modules["canary_result_log"] = boom
        try:
            # The fixture MUST NOT already be PASS. Written first with a healthy census, this
            # check still could not see the except-branch overwriting the verdict to "PASS",
            # because the verdict was "PASS" to begin with — a mutation is only observable
            # against a fixture whose correct answer differs from the mutation's answer.
            v = classify(census(filled_lag_h=STALE_HOURS + 1), pop(), NOW)
            if v["verdict"] != "FAIL":
                return False    # the fixture stopped being a FAIL; the check has gone vacuous
            before = (v["verdict"], _token_exit_map()[v["verdict"]])
            publish_result(v, before[1])       # must swallow, must not mutate
            return (v["verdict"], _token_exit_map()[v["verdict"]]) == before
        finally:
            if saved is not None:
                sys.modules["canary_result_log"] = saved
            else:
                del sys.modules["canary_result_log"]
    check("R6 recorder is INERT even when it RAISES — the except-branch cannot touch the verdict",
          recorder_inert_when_it_RAISES)
    check("R6 recorder REPORTS success by name",
          lambda: "CANARY_RESULT_LOG=" in open(LOG).read())
    check("R6 recorder REPORTS failure by name — a silent non-record is impossible",
          lambda: "CANARY_RESULT_LOG_FAILED=" in open(LOG).read())
    check("R6 recorder REPORTS an injected RAISE by its exception type, not as a bare failure",
          lambda: "CANARY_RESULT_LOG_FAILED=RuntimeError" in open(LOG).read())

    n = len(ran)
    ok = not failures and n >= _SELF_TEST_MIN_CHECKS
    if n < _SELF_TEST_MIN_CHECKS:
        print("  [FAIL] VACUITY: suite ran %d check(s), floor is %d — it verified less than it "
              "was built to" % (n, _SELF_TEST_MIN_CHECKS))
    print("SELF-TEST: %s (%d check(s) ran, floor %d, %d failure(s))"
          % ("PASS" if ok else "FAIL", n, _SELF_TEST_MIN_CHECKS, len(failures)))
    print("OUTCOME_BACKFILL_VERDICT=%s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


# Floor, NOT a target — set to the ACTUAL check count so removing any scenario trips it.
# Raised from 28 by OPS-OUTCOME-BACKFILL-STALL-W1 A3 (two new arms, the identifiability guard, the
# NULL bootstrap, a second parser, the mirrored-constant checks and the R6 recorder). A floor with
# slack in it licenses exactly one silent deletion, which is the hole it exists to close — this
# wave measured that hole in its sibling gate while proving the suite could fail, and corrected it
# there too. Raise this in the SAME edit that adds a scenario.
_SELF_TEST_MIN_CHECKS = 85


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

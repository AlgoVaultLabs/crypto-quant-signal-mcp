#!/usr/bin/env python3
"""outcome-backfill-freshness.py — OPS-RECALIBRATE-HARNESS-RETIRE-W1 (R4),
re-keyed and given two more arms by OPS-OUTCOME-BACKFILL-STALL-W1 (A3), and made to judge the
producer through the producer's OWN census by OPS-ALARM-OWNER-DERIVATION-W1 (CH1).

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

So: THREE ARMS (four since CH1), and they are not separable. Each prints its own positive line;
ONE token.

  ARM 1  PRODUCER      max(outcome_filled_at) — is the backfill WRITING? (its own direct read)
  ARM 2  POPULATION    per-timeframe high-water marks against each lane's OWN maturation
                       horizon — is the emitted MIX pinning the global max?
  ARM 3  REACHABILITY  (a) workable backlog (minus rows the venue can no longer serve) vs the
                           producer's own cap;
                       (b) queue-frontier age — the quantity that actually paged 12.1h,
                           here under its correct name;
                       (c) sediment: pending rows the durable breaker has maxed out. Rising
                           sediment means the breaker is not holding.
  ARM 3d VENUE SILENCE (CH1) a venue whose rows matured, were attempted, and filled NONE in 24 h —
                       its own alert, OUTCOME_BACKFILL_VENUE_SILENT.

ARM 3's backlog is an UNCAPPED `count(*)`. Never aggregate over the LIMIT-capped read: both
sides would come from the same capped array and the check would only confirm the tree matches
itself. That is the estate's standing capped-collection law, and this queue is the exact trap it
describes.

Aggregate precedence across arms: FAIL > INDETERMINATE > PASS. An arm that could not evaluate
never launders into a pass, and a real FAIL is never masked by a sibling's INDETERMINATE.

────────────────────────────────────────────────────────────────────────────────────────────
── CH1 (2026-10-10): THE CANARY EXECUTES THE PRODUCER'S OWN CENSUS ─────────────────────────
────────────────────────────────────────────────────────────────────────────────────────────
Until CH1 arms 2-3 judged the producer through a hand-written Python MIRROR of its queue predicate
and of `EVAL_CANDLES`. A mirror is a second derivation, and it drifts: the sibling drain gate's copy
never got A1b's maturity clause, and this file's parity check compared constants only, and only
when a checkout sat beside it — never on the host where it runs. The mirror is DELETED. Arms 2-3
now execute the SQL the producer's own builders emit (`docker exec <app> node
dist/scripts/backfill-queue-census.js --emit-sql --now <now>`), through this file's existing
`aoe_readonly` seam, so no change to the queue, the cap, the cooldown, the horizons or the venue
reach table can ever reach the producer without reaching this canary in the same deploy.

ARM 1 deliberately keeps its OWN direct query (newest stamp, stamped/matured totals, emissions): it
reads the producer's RECORD, not a predicate, and an emitter failure must not blind it. The
emitter failing makes arms 2-3 INDETERMINATE while arm 1 still evaluates.

3a SUBTRACTS `past_reach` — pending rows older than their venue's measured candle depth. They are
EXOGENOUS (a clock against the venue's served depth; the clause references no attempt column, and
this canary REFUSES emitted SQL whose clause does — RIDER 4, enforced at runtime), and since CH1 the
queue no longer serves them: a venue that cannot serve a row's window either returns nothing (HL
answers 500, which trips the producer's per-coin breaker and starves that coin's in-reach rows) or,
on six count-limited venues, fills it from the wrong window. Approved CONDITIONALLY on arm 3d
paging in the same change, which it does: 3d is what keeps a broken adapter from hiding while its
rows age past reach and leave the queue.

The alert BODY now projects from the checks that failed (one map, check-id -> sentence). The static
paragraph it replaces asserted "CANNOT SEE the newest signals" on every page — including the
2026-10-10 one, whose frontier was 0.70 h.

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
              unchanged by A3 and CH1. Revisit row: `Claude files/defensive-reductions-to-revisit.md`.
SUSTAIN     : 2 consecutive hourly breaches before paging — the estate's sustained-drift
              criterion, for BOTH alerts. Detection latency ~13h vs the retired alarm's 48h.
ARM 3d      : DENOMINATOR = per-venue rows that matured in the trailing 24 h; WINDOW = 24 h.
              FAIL iff matured_24h >= N_MIN AND filled_24h = 0 AND attempted_24h > 0.
              N_MIN = 1, CALIBRATED (see VENUE_SILENT_N_MIN).

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
refusal is honest. Since CH1 the horizons come from the producer's emitter, never a local copy.

── Contract (UNCHANGED by A3 and CH1, deliberately) ─────────────────────────────────────────
Verdict token: exactly one terminal `OUTCOME_BACKFILL_VERDICT=PASS|FAIL|INDETERMINATE`.
Exit: 0 = evaluated (PASS, or FAIL with the alert sent) · 3 = INDETERMINATE (verified NOTHING).
3 is the token-law default for a NEW gate. Callers gate on the TOKEN, never the bare exit code.
Alert id `OUTCOME_BACKFILL_STALLED`; recommended wave `OPS-OUTCOME-BACKFILL-STALL-W{NEXT}` —
inherited verbatim from the retiring `ops/closedbar-recalibrate-config.json`, whose own `alerts`
block records why it must differ from the readiness wave: "one recommended_wave shared by two
alerts with opposite remedies is the generator bug that sent an operator to run the wave that
would have ratified a broken state." Arm 3d pages its OWN id `OUTCOME_BACKFILL_VENUE_SILENT` with
its own remedy `OPS-ADAPTER-FILL-SILENT-W{NEXT}` for the same reason.

FAIL-CLOSED. psql failure, an unparseable row, or a NULL where a number was promised is
INDETERMINATE — input we were HANDED and could not parse is never a pass. Reads as
`aoe_readonly` over the container's `local ... trust` line: least privilege, and the role cannot
write, so read-only intent is enforced by the role and not only by the SET below.

── A3 also makes this canary REMOTELY DIAGNOSABLE (R6) ──────────────────────────────────────
Every run appends one structured record through `canary_result_log.append_result()`, which the
existing `monitoring-results-sync.sh` PULL union-merges into `Claude files/canary-results.jsonl`.
The recorder NEVER changes the verdict, the exit code or the alert dispatch: a logging bug must
not become a paging bug. A failure to record is REPORTED, never silent.

Env / test seams:
  OBF_PSQL_CMD    override the psql command (default: docker exec … psql -U aoe_readonly …)
  OBF_EMITTER_CMD override the census emitter (default: docker exec <app> node
                  dist/scripts/backfill-queue-census.js --emit-sql --now {now}); `{now}` is filled
  OBF_STATE_FILE  streak state       OBF_LOG            log path
  OBF_WRAPPER     send_telegram.sh   OBF_NOW_EPOCH      freeze "now"
  OBF_ALERT_STATE_DIR the wrapper's marker dir — the resolution gates READ <ALERT_ID>-last-fired-at
                  there (episode_open); this canary never writes it
  OBF_STALE_HOURS threshold (12)     OBF_INPUT_WINDOW_HOURS input guard window (3)
  OBF_CONSECUTIVE_TO_PAGE sustain (2)
  OBF_SELFTEST=1  short-circuits fire() / clear()
  ALGOVAULT_TG_TEST_INERT=1 suppresses BEFORE the wrapper's cooldown gate and writes no marker.
                  DRY_RUN_TG=1 is NOT inert — it writes the 24h marker, so back-to-back dry runs
                  FALSE-GREEN by cooldown suppression rather than by health.
  --self-test     hermetic scenario suite; no DB, no wrapper, no emitter, temp state.

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
# Arm 3d's own alert (CH1). Its fire site in fire_venue_silent() is a LITERAL list:
# scripts/check-alert-registry.mjs finds alert ids by POSITION, and a parameterised id is invisible.
VENUE_SILENT_ALERT = "OUTCOME_BACKFILL_VENUE_SILENT"
VENUE_SILENT_WAVE = "OPS-ADAPTER-FILL-SILENT-W{NEXT}"
PRODUCER = "backfill-outcomes (crontab 2-59/3)"
CANARY_NAME = "outcome_backfill_freshness"

WRAPPER = os.environ.get("OBF_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
TG = WRAPPER
STATE_FILE = os.environ.get(
    "OBF_STATE_FILE", "/opt/algovault-monitoring/.alert-state/outcome-backfill-freshness.json")
# send_telegram.sh's STATE_DIR — where it writes `<ALERT_ID>-last-fired-at` on a delivered fire and
# removes it on a delivered clear. The resolution gates READ it (episode_open); nothing here writes.
ALERT_STATE_DIR = os.environ.get("OBF_ALERT_STATE_DIR", "/opt/algovault-monitoring/.alert-state")
LOG = os.environ.get("OBF_LOG", "/var/log/algovault-outcome-backfill-freshness.log")

PSQL_DEFAULT = (
    "docker exec crypto-quant-signal-mcp-postgres-1 "
    "psql -U aoe_readonly -d signal_performance -tA"
)
EMITTER_DEFAULT = (
    "docker exec crypto-quant-signal-mcp-mcp-server-1 "
    "node dist/scripts/backfill-queue-census.js --emit-sql --now {now}"
)


def _int_env(name, default, floor=1):
    try:
        return max(floor, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


STALE_HOURS = _int_env("OBF_STALE_HOURS", 12)
INPUT_WINDOW_HOURS = _int_env("OBF_INPUT_WINDOW_HOURS", 3)
CONSECUTIVE_TO_PAGE = _int_env("OBF_CONSECUTIVE_TO_PAGE", 2)

# ── Arm 3d's N_MIN — CALIBRATED, not chosen (OPS-ALARM-OWNER-DERIVATION-W1 R0.5, 2026-10-10) ────
# Instrument: `signals` per venue per UTC day, 2026-09-08..10-09 (512 venue-days; matured = became
# due that day, filled = outcome_filled_at that day, attempted = outcome_last_attempt_at that day —
# the LAST attempt only, so a lower bound). Exactly ONE zero-fill venue-day carried attempts:
# BITMART 2026-10-09 (matured 0, attempted 67) — a RETIRED venue whose 67 pending rows retry after
# cooldown, i.e. a labelled NON-outage. Zero labelled outages. N_MIN is the smallest integer such
# that every zero-fill venue-day with matured >= N_MIN is a labelled outage: 1 (0 would admit the
# retired venue). Active venues matured >= 25 rows on every one of their 480 venue-days, so the
# margin is wide. Revisit row: `Claude files/defensive-reductions-to-revisit.md`.
VENUE_SILENT_N_MIN = 1

# ── The emitter's contract: exactly the keys and columns this canary READS ─────────────────────
# `tests/unit/backfill-census-single-derivation.test.ts` pins every tuple below against the emitter
# and the builders, and feeds the REAL census SQL's output through the parsers below — the artifacts
# the hermetic self-test necessarily replaces with fixtures.
EMITTER_KEYS = ("census_sql", "venue_sql", "past_reach_clause", "horizons_s", "constants",
                "reach_measured_at", "source_sha")
EMITTER_CONSTANT_KEYS = ("limit", "max_attempts", "cooldown_s", "reach_margin_s")
CENSUS_COLUMNS = ("backlog_uncapped", "immature", "parked", "past_reach", "servable_uncapped",
                  "frontier")
VENUE_COLUMNS = ("venue", "matured_24h", "filled_24h", "attempted_24h", "past_reach_entered_24h",
                 "servable")
EMIT_TOKEN = "BACKFILL_CENSUS_EMIT_VERDICT"
# Outcome VALUE columns. The census needs none of them, so emitted SQL naming one is refused —
# Data Integrity: this canary reads cardinalities, timestamps and IS NULL predicates only.
OUTCOME_VALUE_TOKENS = ("outcome_return_pct", "mae_return_pct", "pfe_return_pct", "pfe_price",
                        "mae_price", "return_1candle")
# The producer's OWN state. A 3a subtrahend built from any of these would be ENDOGENOUS.
ENDOGENOUS_COLUMNS = ("outcome_attempts", "outcome_last_attempt_at", "outcome_filled_at")


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


# ── the queries THIS file still builds, as pure fns so --self-test can assert their SHAPE ─────

def ro(sql):
    """Every statement this canary sends runs in a read-only transaction — on top of the role,
    which cannot write anyway. One statement only: a trailing separator is normalised, never added
    twice."""
    return "SET default_transaction_read_only=on; %s;" % sql.strip().rstrip(";")


def build_producer_sql(now):
    """ARM 1's own read of the producer's RECORD: newest write stamp, stamped and matured totals, and
    recent emissions. Not a predicate — which is why it stays here, independent of the emitter.

    `created_at` and `outcome_filled_at` are INTEGER epochs on this table, not timestamptz — so every
    window is plain integer arithmetic. `pfe_return_pct` appears only as `IS NOT NULL`.
    """
    window_start = int(now) - INPUT_WINDOW_HOURS * 3600
    return ro(
        "SELECT MAX(outcome_filled_at) AS newest_filled, "
        "COUNT(*) FILTER (WHERE outcome_filled_at IS NOT NULL) AS stamped_total, "
        "COUNT(*) FILTER (WHERE pfe_return_pct IS NOT NULL) AS matured_total, "
        "COUNT(*) FILTER (WHERE created_at > {ws}) AS emitted_recent "
        "FROM signals".format(ws=window_start))


def build_population_sql(now):
    """Arm 2: per-timeframe emission + maturation high-water mark.

    Kept on `created_at` deliberately — this arm IS the population reading that the re-key
    retires from arm 1. Reporting it BY NAME is what turns a silent metric redefinition into a
    stated fact, per the wave's R5.3.
    """
    window_start = int(now) - INPUT_WINDOW_HOURS * 16 * 3600
    return ro(
        "SELECT timeframe, "
        "COUNT(*) FILTER (WHERE created_at > {ws}) AS emitted_window, "
        "COALESCE(MAX(created_at) FILTER (WHERE pfe_return_pct IS NOT NULL), -1) AS max_matured "
        "FROM signals GROUP BY timeframe ORDER BY timeframe".format(ws=window_start))


# ── parsers — pure, so the self-test can drive them; the vitest drives them on REAL output ─────

def _data_rows(stdout):
    """psql -tA rows carrying a field separator; the SET command tag and notices carry none."""
    return [[p.strip() for p in line.split("|")]
            for line in (stdout or "").strip().splitlines() if "|" in line]


def parse_producer(stdout):
    """Arm 1's row. `newest_filled` may legitimately be EMPTY (the bootstrap FACT "nothing stamped
    yet"); the counts must be numbers. Handed input we cannot parse is INDETERMINATE."""
    for parts in _data_rows(stdout):
        if len(parts) != 4:
            continue
        nf, st, mt, er = parts
        if not (st.isdigit() and mt.isdigit() and er.isdigit()):
            continue
        return {"newest_filled": int(nf) if nf.isdigit() else None, "stamped_total": int(st),
                "matured_total": int(mt), "emitted_recent": int(er)}
    raise Indeterminate(
        "no parseable producer row in psql output (got %r) — handed input we could not parse is "
        "INDETERMINATE, never PASS" % (stdout or "").strip()[:200])


def parse_population(stdout):
    """Rows of `timeframe|emitted_window|max_matured`. `-1` encodes "never matured".

    An EMPTY result set is a FACT (no rows at all) and parses to `[]`; arm 2 then reports
    NOT_IDENTIFIABLE rather than inventing a verdict over nothing.
    """
    rows = []
    for parts in _data_rows(stdout):
        if len(parts) != 3:
            continue
        tf, emitted, mx = parts
        if not (emitted.isdigit() and mx.lstrip("-").isdigit()):
            continue
        rows.append({"timeframe": tf, "emitted": int(emitted),
                     "max_matured": None if int(mx) < 0 else int(mx)})
    return rows


def parse_emission(stdout):
    """The emitter's stdout: exactly ONE JSON line and a terminal `<EMIT_TOKEN>=PASS`.

    Anything else — no token, a non-PASS token, zero or two JSON lines, a missing key, a malformed
    constant or horizon — is INDETERMINATE: the producer's own census is the only thing arms 2-3 are
    allowed to judge it by, and a census we cannot trust is not a census.
    """
    lines = [ln.strip() for ln in (stdout or "").splitlines() if ln.strip()]
    tokens = [ln for ln in lines if ln.startswith(EMIT_TOKEN + "=")]
    if not tokens:
        raise Indeterminate("the emitter printed no %s token" % EMIT_TOKEN)
    if tokens[-1] != EMIT_TOKEN + "=PASS":
        raise Indeterminate("the emitter said %s" % tokens[-1])
    blobs = [ln for ln in lines if ln.startswith("{")]
    if len(blobs) != 1:
        raise Indeterminate("the emitter printed %d JSON lines, expected exactly 1" % len(blobs))
    try:
        em = json.loads(blobs[0])
    except ValueError as e:
        raise Indeterminate("the emitter's JSON is unparseable: %s" % e)
    if not isinstance(em, dict):
        raise Indeterminate("the emitter's JSON is not an object")
    missing = [k for k in EMITTER_KEYS if k not in em]
    if missing:
        raise Indeterminate("the emitter's JSON lacks %s" % ",".join(missing))
    c = em["constants"]
    if not isinstance(c, dict) or any(type(c.get(k)) is not int or c.get(k) <= 0
                                      for k in EMITTER_CONSTANT_KEYS):
        raise Indeterminate("the emitter's constants are malformed: %r" % (c,))
    h = em["horizons_s"]
    if not isinstance(h, dict) or not h or any(type(x) is not int or x <= 0 for x in h.values()):
        raise Indeterminate("the emitter's horizons are malformed: %r" % (h,))
    for k in ("census_sql", "venue_sql", "past_reach_clause", "source_sha", "reach_measured_at"):
        if not isinstance(em[k], str) or not em[k].strip():
            raise Indeterminate("the emitter's %s is empty" % k)
    for k in ("census_sql", "venue_sql"):
        if not em[k].lstrip().upper().startswith("SELECT "):
            raise Indeterminate("the emitter's %s is not a SELECT" % k)
    return em


def emitted_sql_problems(em):
    """What this canary REFUSES to execute, as data. Empty list = clean.

      * an outcome VALUE column in the census SQL (label-blindness, enforced on the live SQL);
      * a statement separator (one statement per call, inside the read-only transaction);
      * RIDER 4 AT RUNTIME: the past-reach subtrahend naming the producer's own state — an
        ENDOGENOUS term may never shrink the backlog it is a symptom of;
      * the audited clause not being the one the census executes.
    """
    probs = []
    for k in ("census_sql", "venue_sql"):
        low = em[k].lower()
        hit = [t for t in OUTCOME_VALUE_TOKENS if t in low]
        if hit:
            probs.append("%s names outcome value column(s) %s — this canary is label-blind"
                         % (k, ",".join(hit)))
        if ";" in em[k]:
            probs.append("%s carries a statement separator — one statement per call" % k)
    clause = em["past_reach_clause"]
    endo = [t for t in ENDOGENOUS_COLUMNS if t in clause]
    if endo:
        probs.append("RIDER 4 at runtime: the past-reach subtrahend references %s — an ENDOGENOUS "
                     "term may never shrink the backlog it is a symptom of" % ",".join(endo))
    if clause not in em["census_sql"]:
        probs.append("the audited past-reach clause is not the one the census executes")
    return probs


def parse_emitter_census(stdout):
    """The census's ONE row, in CENSUS_COLUMNS order. `frontier` may be EMPTY — the best possible
    news, "the producer can see no pending work"; every other field must be a count."""
    rows = _data_rows(stdout)
    if len(rows) != 1:
        raise Indeterminate("census: expected exactly one row, got %d (%r)"
                            % (len(rows), (stdout or "").strip()[:200]))
    parts = rows[0]
    if len(parts) != len(CENSUS_COLUMNS):
        raise Indeterminate("census: %d fields, expected %d" % (len(parts), len(CENSUS_COLUMNS)))
    out = {}
    for name, val in zip(CENSUS_COLUMNS, parts):
        if name == "frontier" and val == "":
            out[name] = None
        elif val.isdigit():
            out[name] = int(val)
        else:
            raise Indeterminate("census: %s=%r is not a count" % (name, val))
    return out


def parse_venue_rows(stdout):
    """Per-venue rows in VENUE_COLUMNS order. Zero rows is a FACT ("nothing matured, filled or
    attempted anywhere in 24 h") and parses to []; a malformed row is INDETERMINATE."""
    out = []
    for parts in _data_rows(stdout):
        if len(parts) != len(VENUE_COLUMNS):
            raise Indeterminate("venue census: %d fields, expected %d (%r)"
                                % (len(parts), len(VENUE_COLUMNS), "|".join(parts)[:120]))
        venue, counts = parts[0], parts[1:]
        if not venue or not all(c.isdigit() for c in counts):
            raise Indeterminate("venue census: unparseable row %r" % "|".join(parts)[:120])
        out.append(dict(zip(VENUE_COLUMNS, [venue] + [int(c) for c in counts])))
    return out


# ── seams ─────────────────────────────────────────────────────────────────────────────────────

def _run_psql(sql):
    cmd = os.environ.get("OBF_PSQL_CMD", PSQL_DEFAULT)
    try:
        out = subprocess.run(cmd.split() + ["-c", sql], capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        raise Indeterminate("psql could not run: %s: %s" % (type(e).__name__, e))
    if out.returncode != 0:
        raise Indeterminate("psql failed rc=%d: %s" % (out.returncode, out.stderr.strip()[:200]))
    return out.stdout


def run_emitter(now):
    """The producer's own census, at THIS run's pinned `now`. Refused emitted SQL is INDETERMINATE."""
    cmd = os.environ.get("OBF_EMITTER_CMD", EMITTER_DEFAULT).format(now=int(now))
    try:
        out = subprocess.run(cmd.split(), capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as e:
        raise Indeterminate("the census emitter could not run: %s: %s" % (type(e).__name__, e))
    if out.returncode != 0:
        raise Indeterminate("the census emitter failed rc=%d: %s"
                            % (out.returncode, (out.stderr or out.stdout).strip()[:200]))
    em = parse_emission(out.stdout)
    probs = emitted_sql_problems(em)
    if probs:
        raise Indeterminate("emitted SQL refused: " + "; ".join(probs))
    return em


def gather(now):
    """Every input, each failure isolated: an emitter or census failure blinds arms 2-3 and 3d,
    never arm 1, and a producer-read failure never blinds the census."""
    inp = {"producer": None, "producer_error": None, "emission": None, "census": None,
           "venues": None, "census_error": None, "population": None, "population_error": None}
    try:
        inp["producer"] = parse_producer(_run_psql(build_producer_sql(now)))
    except Indeterminate as e:
        inp["producer_error"] = str(e)
    try:
        em = run_emitter(now)
        inp["emission"] = em
        inp["census"] = parse_emitter_census(_run_psql(ro(em["census_sql"])))
        inp["venues"] = parse_venue_rows(_run_psql(ro(em["venue_sql"])))
    except Indeterminate as e:
        inp["census_error"] = str(e)
    if inp["emission"] is None:
        inp["population_error"] = "no horizons — the census emitter did not answer (%s)" % inp["census_error"]
    else:
        try:
            inp["population"] = parse_population(_run_psql(build_population_sql(now)))
        except Indeterminate as e:
            inp["population_error"] = str(e)
    return inp


# ── POPULATION DECLARATIONS — every arm names what it counts and what it excludes ────────────
#
# The generator fix for THREE conflations A3 produced, each a metric mixing the thing under test
# with a population term:
#   (1) the original key      backfill staleness + the emitted mix's maturation horizon
#   (2) the A2 drain gate     producer throughput + arrival rate (b1)
#   (3) ARM 3a's first re-key unreachable work + not-yet-due work — and then, in the proposed
#                             repair, + the producer's OWN FAILURE population
#
# Each exclusion carries a tag. EXOGENOUS terms are fixed by something outside the monitored
# system (a clock, a calendar, a venue's served depth). ENDOGENOUS terms are functions of the
# monitored system's own behaviour. THE LAW, asserted by the self-test (and since CH1 on the live
# emitted SQL): an ENDOGENOUS term may be REPORTED and may carry its OWN arm, but may NEVER appear
# as a subtrahend in a VERDICT INPUT — subtracting a failure population from a health metric makes
# the metric improve as the system degrades.
PRODUCER_POPULATION = {
    "counts": "age of the newest producer write (max outcome_filled_at)",
    "excludes": [],
    "reported_not_subtracted": [],
    "verdict_subtrahends": [],
}
LANE_POPULATION = {
    "counts": "per-timeframe maturation high-water marks, judged against each lane's own horizon",
    "excludes": [("lanes with no known horizon", "EXOGENOUS"),
                 ("lanes not currently emitting", "EXOGENOUS")],
    "reported_not_subtracted": [],
    "verdict_subtrahends": [],
}
REACH_POPULATION = {
    "counts": "pending rows the producer could work on now",
    "excludes": [("immature", "EXOGENOUS"), ("past_reach", "EXOGENOUS")],
    "reported_not_subtracted": [("parked", "ENDOGENOUS")],
    "verdict_subtrahends": [("immature", "EXOGENOUS"), ("past_reach", "EXOGENOUS")],
}
VENUE_POPULATION = {
    "counts": "per-venue rows matured, filled and attempted in the trailing 24 h",
    "excludes": [("venues with matured_24h below N_MIN", "EXOGENOUS")],
    "reported_not_subtracted": [],
    "verdict_subtrahends": [],
}


WORST_FIRST = {"FAIL": 0, "INDETERMINATE": 1, "PASS": 2}


def aggregate(verdicts):
    """FAIL > INDETERMINATE > PASS. An arm that could not evaluate never launders into a pass,
    and a real FAIL is never masked by a sibling's INDETERMINATE."""
    return sorted(verdicts, key=lambda v: WORST_FIRST[v])[0] if verdicts else "INDETERMINATE"


def indeterminate_arm(name, population, why):
    """An arm whose input never arrived. It declares its population like every other arm (RIDER 4
    inspects every state an arm can be in) and says WHY in words."""
    return {"name": name, "verdict": "INDETERMINATE", "population": population,
            "detail": "INDETERMINATE: %s" % why}


def arm_producer(census, now, stale_hours=None):
    """ARM 1 — is the backfill WRITING? Keyed on the producer's own stamp, never on input time."""
    stale_h = STALE_HOURS if stale_hours is None else stale_hours
    input_flowing = census["emitted_recent"] > 0
    if census["stamped_total"] == 0 or census["newest_filled"] is None:
        # The NULL bootstrap. Not PASS (fail-open on the arm the re-key exists to create) and not
        # FAIL (a spurious page on deploy night). Self-resolves on the producer's next write.
        return {"name": "producer", "verdict": "INDETERMINATE", "lag_h": None,
                "input_flowing": input_flowing, "population": PRODUCER_POPULATION,
                "detail": "BOOTSTRAP: no row carries outcome_filled_at yet — A1 deliberately did "
                          "not backfill history; resolves on the producer's next write "
                          "(stamped_total=%d)" % census["stamped_total"]}
    lag_h = max(0.0, (now - census["newest_filled"]) / 3600.0)
    stuck = lag_h > stale_h
    breach = bool(input_flowing and stuck)
    return {"name": "producer", "verdict": "FAIL" if breach else "PASS", "lag_h": lag_h,
            "input_flowing": input_flowing, "population": PRODUCER_POPULATION,
            "detail": "producer_lag_h=%.2f threshold=%dh input_flowing=%s (emitted_last_%dh=%d) "
                      "stamped_total=%d"
                      % (lag_h, stale_h, "Y" if input_flowing else "N", INPUT_WINDOW_HOURS,
                         census["emitted_recent"], census["stamped_total"])}


def arm_population(rows, now, horizons, stale_hours=None):
    """ARM 2 — is the emitted MIX pinning the global max, and is the question even identifiable?

    `horizons` is the producer's own `{timeframe: seconds}` map (the emitter's `horizons_s`), so a
    lane's horizon can never disagree with the queue that admits it.

    Each lane is judged against its OWN maturation horizon, never against the global threshold:
    a 1d lane whose newest matured row is 90h old is HEALTHY (horizon 96h), and calling that a
    stall is precisely the population/producer conflation this canary exists to retire.

    IDENTIFIABILITY comes first. If no lane that is currently EMITTING has a horizon shorter than
    the threshold, no observation can distinguish a stalled producer from a slow-maturing mix —
    the threshold is unattainable by construction. NOT_IDENTIFIABLE -> INDETERMINATE.
    """
    stale_h = STALE_HOURS if stale_hours is None else stale_hours
    emitting = [r for r in rows if r["emitted"] > 0 and horizons.get(r["timeframe"])]
    if not emitting:
        return {"name": "population", "verdict": "INDETERMINATE", "lanes": [],
                "population": LANE_POPULATION,
                "detail": "NOT_IDENTIFIABLE: no lane with a known horizon is emitting"}
    attainable = [r for r in emitting if horizons[r["timeframe"]] <= stale_h * 3600]
    if not attainable:
        widths = ", ".join("%s %.2fh" % (r["timeframe"], horizons[r["timeframe"]] / 3600.0)
                           for r in emitting)
        return {"name": "population", "verdict": "INDETERMINATE", "lanes": [],
                "population": LANE_POPULATION,
                "detail": "NOT_IDENTIFIABLE: every emitting lane matures slower than the %dh "
                          "threshold (%s) — unattainable by construction, so a breach would carry "
                          "no information about the producer" % (stale_h, widths)}
    lanes, stalled = [], []
    for r in attainable:
        h = horizons[r["timeframe"]]
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
            "population": LANE_POPULATION,
            "detail": ("lanes " + " · ".join(
                "%s(h=%.2f lag=%s)" % (ln["tf"], ln["horizon_h"],
                                       "never" if ln["lag_h"] is None else "%.2f" % ln["lag_h"])
                for ln in lanes)
                + ("" if not stalled else "  STALLED: " + ",".join(stalled)))}


def arm_reachability(census, now, limit, stale_hours=None):
    """ARM 3 — can the producer SEE fresh work? `limit` is the producer's own cap (emitter constant).

    (a) The WORKABLE backlog the producer could still serve vs its cap: `raw − immature −
        past_reach`. The check id stays `workable_within_cap` so pages read alike across the change;
        `workable` (raw − immature, the pre-CH1 quantity) stays REPORTED under its old name, so the
        series behind it never silently changes meaning.
    (b) Queue-frontier age — `MAX(created_at)` of the producer's own LIMITed queue.
    (c) Sediment: pending rows the durable breaker has maxed out. Reported ALWAYS; FAIL only when
        sediment alone would fill the window, which is the terminal state of the original outage.
    """
    stale_h = STALE_HOURS if stale_hours is None else stale_hours
    backlog, parked, immature = census["backlog_uncapped"], census["parked"], census["immature"]
    past_reach, servable = census["past_reach"], census["servable_uncapped"]
    # 3a's SUBJECT. `raw − immature − past_reach`, and ONLY that.
    #
    # `immature` is EXOGENOUS: fixed by `created_at + (EVAL_CANDLES+1)xTF`, a clock the producer
    # cannot influence, and literally the queue's own admission predicate. Subtracting it is a
    # units fix.
    #
    # `past_reach` is EXOGENOUS (CH1): a clock against the venue's measured candle depth — the
    # clause references no attempt column (refused at runtime if it ever does), and the queue no
    # longer serves these rows, so they cannot starve a window they are not in.
    #
    # `parked` is ENDOGENOUS and is DELIBERATELY NOT SUBTRACTED. It is the producer's own failure
    # population, so subtracting it would read GREENER the more the producer fails — refuted 5/5 by
    # adversarial review in A3. It survives only as its own check (3c) and as a reported field.
    workable = backlog - immature
    reachable = workable - past_reach
    frontier_age_h = 0.0 if census["frontier"] is None else \
        max(0.0, (now - census["frontier"]) / 3600.0)
    checks = [
        ("workable_within_cap", reachable < limit,
         "workable_reachable=%d (raw=%d - immature=%d - past_reach=%d) cap=%d ratio=%.1f%%  "
         "[raw reported, not a verdict input] | workable=%d servable_uncapped=%d"
         % (reachable, backlog, immature, past_reach, limit, 100.0 * reachable / limit,
            workable, servable)),
        ("frontier_reachable", frontier_age_h <= stale_h,
         "queue_frontier_age_h=%.2f threshold=%dh" % (frontier_age_h, stale_h)),
        ("parked_cohort_bounded", parked < limit,
         "parked=%d (maxed attempts AND within the producer's cooldown) cap=%d — a breaker that "
         "has parked more rows than the window can hold is broken at any baseline"
         % (parked, limit)),
    ]
    bad = [n for n, ok, _ in checks if not ok]
    return {"name": "reachability", "verdict": "FAIL" if bad else "PASS", "checks": checks,
            "population": REACH_POPULATION,
            "frontier_age_h": frontier_age_h, "backlog": backlog, "parked": parked,
            "immature": immature, "past_reach": past_reach, "servable_uncapped": servable,
            "workable": workable, "workable_reachable": reachable, "limit": limit,
            "detail": " | ".join(d for _, _, d in checks)
                      + ("" if not bad else "  FAILING: " + ",".join(bad))}


def arm_venue_silence(venues, n_min=None):
    """ARM 3d — is a venue's adapter failing outright? (CH1, its own alert.)

    FAIL iff a venue had rows become due (matured_24h >= N_MIN), the producer TRIED them
    (attempted_24h > 0), and filled NONE (filled_24h = 0). A venue the producer never attempted is
    starvation or thinness — another arm's subject, not an adapter failure — and a venue with no
    matured row has nothing to fill. Zero venues is a FACT, reported positively.
    """
    n = VENUE_SILENT_N_MIN if n_min is None else n_min
    silent = [v for v in venues
              if v["matured_24h"] >= n and v["filled_24h"] == 0 and v["attempted_24h"] > 0]
    crossed = sum(v["past_reach_entered_24h"] for v in venues)
    detail = ("venues=%d silent=%d (rule: matured_24h >= %d AND filled_24h = 0 AND attempted_24h "
              "> 0) past_reach_entered_24h=%d" % (len(venues), len(silent), n, crossed))
    if silent:
        detail += "  SILENT: " + " · ".join(
            "%s(matured=%d filled=0 attempted=%d)" % (s["venue"], s["matured_24h"], s["attempted_24h"])
            for s in silent)
    elif not venues:
        detail += " — no venue matured, filled or attempted a row in 24 h (a FACT; arm 1 owns a dead producer)"
    return {"name": "venue_silence", "verdict": "FAIL" if silent else "PASS", "silent": silent,
            "evaluated": len(venues), "population": VENUE_POPULATION, "detail": detail}


def classify(inputs, now, stale_hours=None):
    """Compose the arms into ONE verdict. Single derivation: every consumer — the log lines, both
    alert bodies, the R6 record and the exit code — projects from this one value.

    `parent_verdict` (arms 1-3) drives OUTCOME_BACKFILL_STALLED; `venue_verdict` (arm 3d) drives
    OUTCOME_BACKFILL_VENUE_SILENT; `verdict` (all four) is the token.
    """
    em = inputs.get("emission")
    p = inputs.get("producer")
    producer = (arm_producer(p, now, stale_hours) if p is not None else
                indeterminate_arm("producer", PRODUCER_POPULATION,
                                  inputs.get("producer_error") or "no producer read"))
    if em is not None and inputs.get("population") is not None:
        population = arm_population(inputs["population"], now, em["horizons_s"], stale_hours)
    else:
        population = indeterminate_arm("population", LANE_POPULATION,
                                       inputs.get("population_error") or "no population read")
    if em is not None and inputs.get("census") is not None:
        reach = arm_reachability(inputs["census"], now, em["constants"]["limit"], stale_hours)
    else:
        reach = indeterminate_arm("reachability", REACH_POPULATION,
                                  inputs.get("census_error") or "no census")
    if inputs.get("venues") is not None:
        venue = arm_venue_silence(inputs["venues"])
    else:
        venue = indeterminate_arm("venue_silence", VENUE_POPULATION,
                                  inputs.get("census_error") or "no venue census")
    arms = [producer, population, reach, venue]
    parent = aggregate([producer["verdict"], population["verdict"], reach["verdict"]])
    c = inputs.get("census") or {}
    return {"verdict": aggregate([a["verdict"] for a in arms]),
            "parent_verdict": parent, "venue_verdict": venue["verdict"],
            "arms": arms,
            "breach": parent == "FAIL",
            "venue_breach": venue["verdict"] == "FAIL",
            "census_source": "emitter" if em is not None else "unavailable",
            "census_error": inputs.get("census_error"),
            "source_sha": em["source_sha"] if em is not None else None,
            "reach_measured_at": em["reach_measured_at"] if em is not None else None,
            "queue_limit": em["constants"]["limit"] if em is not None else None,
            "input_flowing": (p or {}).get("emitted_recent", 0) > 0,
            "emitted_recent": (p or {}).get("emitted_recent"),
            "matured_total": (p or {}).get("matured_total"),
            "stamped_total": (p or {}).get("stamped_total"),
            "backlog_uncapped": c.get("backlog_uncapped"),
            "parked": c.get("parked"),
            "immature": c.get("immature"),
            "past_reach": c.get("past_reach"),
            "servable_uncapped": c.get("servable_uncapped")}


def _arm(v, name):
    return next(a for a in v["arms"] if a["name"] == name)


def census_source_line(v):
    """Printed EVERY run: where arms 2-3 got their population from. A run on a stand-in can never
    read like a run on the producer's own census."""
    if v["census_source"] == "emitter":
        return "CENSUS_SOURCE=emitter source_sha=%s reach_measured_at=%s" % (
            v["source_sha"], v["reach_measured_at"])
    return "CENSUS_SOURCE=unavailable reason=%s" % (v.get("census_error") or "unknown")[:200]


def render_eval_lines(v, streak, vs_streak=0):
    """POSITIVE per-ARM output. A run silently skipped by a parse error must never look identical
    to a run that evaluated and passed, and an arm that did not run must be visibly absent."""
    lines = ["EVAL outcome_backfill: verdict=%s streak=%d/%d venue_silent_streak=%d/%d"
             % (v["verdict"], streak, CONSECUTIVE_TO_PAGE, vs_streak, CONSECUTIVE_TO_PAGE)]
    for a in v["arms"]:
        lines.append("  ARM %-13s %-13s %s" % (a["name"], a["verdict"], a["detail"]))
        lines.append("      %s" % render_population(a))
    return lines


def render_population(arm):
    """One line per arm naming what it counts and what it excludes, each exclusion TAGGED.

    Printed every run, not just on failure: an arm whose population is only legible in a code
    review is an arm whose population drifts."""
    pop = arm.get("population") or {}
    ex = ", ".join("%s:%s" % (n, t) for n, t in pop.get("excludes", [])) or "none"
    rep = ", ".join("%s:%s" % (n, t) for n, t in pop.get("reported_not_subtracted", [])) or "none"
    return ("population arm=%s counts=%s excludes=%s reported_not_subtracted=%s"
            % (arm["name"], pop.get("counts", "<UNDECLARED>"), ex, rep))


# ── the BODY projects from the checks that failed — one map, check-id -> sentence ─────────────

def parent_sentences(v):
    """The OUTCOME_BACKFILL_STALLED body's cause lines, ONE per failing check, in a fixed order.
    Nothing here may assert a cause the run did not measure."""
    out = []
    producer, popn, reach = _arm(v, "producer"), _arm(v, "population"), _arm(v, "reachability")
    if producer["verdict"] == "FAIL":
        out.append("PRODUCER: the backfill has not written for %.2f h while signals keep arriving "
                   "— the producer itself is stuck." % producer["lag_h"])
    if popn["verdict"] == "FAIL":
        out.append("POPULATION: lane(s) %s matured nothing inside their own horizon + %dh."
                   % (",".join(ln["tf"] for ln in popn.get("lanes", []) if ln["stalled"]), STALE_HOURS))
    bad = [n for n, ok, _ in reach.get("checks", []) if not ok]
    if "frontier_reachable" in bad:
        out.append("FRONTIER: the producer cannot see the newest signals — its queue frontier is "
                   "%.2f h old (threshold %dh)." % (reach["frontier_age_h"], STALE_HOURS))
    if "workable_within_cap" in bad:
        if "frontier_reachable" in bad:
            out.append("BACKLOG: the workable backlog (%d) also exceeds the window (%d)."
                       % (reach["workable_reachable"], reach["limit"]))
        else:
            out.append("LEADING: the workable backlog exceeds the window; the frontier is %.2f h, "
                       "the series is current, nothing is invisible yet."
                       % reach["frontier_age_h"])
    if "parked_cohort_bounded" in bad:
        out.append("PARKED: %d rows are held by the breaker (cap %d) — a breaker that has parked "
                   "more rows than the window can hold is broken at any baseline."
                   % (reach["parked"], reach["limit"]))
    return out


def venue_sentences(v):
    return ["%s: %d matured, 0 filled, %d attempted in 24 h — its adapter is failing"
            % (s["venue"], s["matured_24h"], s["attempted_24h"])
            for s in _arm(v, "venue_silence").get("silent", [])]


def build_body(v, streak):
    producer, reach, popn = _arm(v, "producer"), _arm(v, "reachability"), _arm(v, "population")
    failing = [a["name"] for a in v["arms"][:3] if a["verdict"] == "FAIL"]
    return "\n".join([
        "\U0001F6D1 %s" % ALERT_ID,
        "",
        "Failing arm(s): %s." % ", ".join(failing),
        *parent_sentences(v),
        "",
        "  producer     : %s" % producer["detail"],
        "  reachability : %s" % reach["detail"],
        "  population   : %s" % popn["detail"],
        "",
        "Producer: %s" % PRODUCER,
        "Consecutive breaches: %d (pages at %d)." % (streak, CONSECUTIVE_TO_PAGE),
        "matured_total=%s" % v["matured_total"],
        census_source_line(v),
        "",
        "Action: dispatch %s via Cowork → Claude Code" % RECOMMENDED_WAVE,
        "Source log: %s" % LOG,
    ])


def build_venue_body(v, vs_streak):
    return "\n".join([
        "\U0001F6D1 %s" % VENUE_SILENT_ALERT,
        "",
        *venue_sentences(v),
        "",
        "Rule: rows matured in 24 h >= %d, filled = 0, attempted >= 1 (N_MIN calibrated 2026-10-10 "
        "over 512 venue-days)." % VENUE_SILENT_N_MIN,
        "Consecutive breaches: %d (pages at %d)." % (vs_streak, CONSECUTIVE_TO_PAGE),
        "Why it pages: a row the backfill cannot fill ages past its venue's served candle depth and "
        "then leaves the queue for good — this alert is what keeps a broken adapter from hiding "
        "behind that exit.",
        census_source_line(v),
        "",
        "Action: dispatch %s via Cowork → Claude Code" % VENUE_SILENT_WAVE,
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


def _state_int(key):
    try:
        return int(_read_state().get(key, 0))
    except (ValueError, TypeError):
        return 0


def read_streak():
    return _state_int("consecutive_breaches")


def read_recovery_streak():
    return _state_int("consecutive_pass")


def read_vs_streak():
    return _state_int("venue_silent_breaches")


def read_vs_recovery():
    return _state_int("venue_silent_pass")


def episode_open(alert_id=ALERT_ID):
    """Is an episode open — did a page actually reach the operator and not yet resolve?

    Answered from send_telegram.sh's OWN cooldown marker, which the wrapper writes on a DELIVERED
    fire and removes on a delivered clear: the same file its cooldown gate, its --clear path and the
    reconciler's FIRING_STALE check already read. Announcing a recovery for an episode nobody was
    told about is chatter, and the marker is the one record of "told about" that cannot disagree
    with the wrapper.

    OPS-DRIFT-ALERT-GENERATORS-W1 retired a private `paged` flag that stood here. It was a SECOND
    record of that one fact, and it arrived with A3 two days AFTER the 2026-09-05 page — so it read
    false for that entire episode, every healthy run skipped --clear, and the reconciler reported
    the marker 8.6 days old as FIRING_STALE while this canary sat at consecutive_pass 169.
    """
    return os.path.exists(os.path.join(ALERT_STATE_DIR, "%s-last-fired-at" % alert_id))


def write_state(streak, v, now, recovery_streak=0, vs_streak=0, vs_recovery=0):
    # No page memory is written here, by design — see episode_open(). A field that recorded
    # "paged" would be a second copy of the wrapper's marker, and it is the copy that went stale.
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        with open(STATE_FILE, "w") as fh:
            json.dump({"consecutive_breaches": streak, "consecutive_pass": recovery_streak,
                       "venue_silent_breaches": vs_streak, "venue_silent_pass": vs_recovery,
                       "last_run_epoch": now,
                       "last_verdict": v["verdict"],
                       "census_source": v["census_source"],
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
    across the threshold within a single hour (12.19 -> 12.13 -> 11.61 -> 11.28).
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


LAST_VS_FIRE = {}
LAST_VS_CLEAR = {}


def fire_venue_silent(body):
    """Arm 3d's page. The argv is LITERAL on purpose (see VENUE_SILENT_ALERT)."""
    argv = [TG, "OUTCOME_BACKFILL_VENUE_SILENT", "CRITICAL_PERSISTENT", "-"]
    LAST_VS_FIRE["body"] = body
    LAST_VS_FIRE["argv"] = argv
    if os.environ.get("OBF_SELFTEST") == "1":
        log("WOULD_FIRE: %s (self-test — wrapper skipped)" % VENUE_SILENT_ALERT)
        return
    proc = subprocess.run(argv, input=body, capture_output=True, text=True, timeout=30)
    log("wrapper[%s] exit=%d out=%s" % (VENUE_SILENT_ALERT, proc.returncode,
                                        (proc.stdout or proc.stderr).strip()[:160]))


def clear_venue_silent(reason):
    """Arm 3d's resolution: mode flag FIRST, reason positional (the wrapper's argv contract).
    Silent by registry default — the wrapper removes its marker without a POST."""
    argv = [TG, "--clear", "OUTCOME_BACKFILL_VENUE_SILENT", reason]
    LAST_VS_CLEAR["reason"] = reason
    LAST_VS_CLEAR["argv"] = argv
    if os.environ.get("OBF_SELFTEST") == "1":
        log("WOULD_CLEAR: %s (%s) (self-test — wrapper skipped)" % (VENUE_SILENT_ALERT, reason))
        return
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=30)
    log("wrapper[%s] --clear exit=%d out=%s" % (VENUE_SILENT_ALERT, proc.returncode,
                                                (proc.stdout or proc.stderr).strip()[:160]))


def publish_result(v, exit_code, path=None):
    """R6 — one structured record per run, so the NEXT occurrence is a file read and not an SSH
    session. A RECORDER, never a gate: it cannot change the verdict, the exit code or the alert
    dispatch, it never raises, and a failure to record is REPORTED rather than silent.

    `path` is a TEST SEAM: `canary_result_log` resolves its target at MODULE IMPORT time, so a later
    env change cannot steer it; production passes nothing and keeps the module default.
    """
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import canary_result_log  # noqa: PLC0415 — deliberately local; see docstring
        reach = _arm(v, "reachability")
        metrics = {
            "arms": {a["name"]: a["verdict"] for a in v["arms"]},
            "census_source": v["census_source"],
            "source_sha": v["source_sha"],
            "producer_lag_h": _arm(v, "producer").get("lag_h"),
            "queue_frontier_age_h": reach.get("frontier_age_h"),
            "backlog_uncapped": v["backlog_uncapped"],
            "queue_limit": v["queue_limit"],
            "parked": v["parked"],
            "immature": v["immature"],
            "past_reach": v["past_reach"],
            "servable_uncapped": v["servable_uncapped"],
            "workable": reach.get("workable"),
            "workable_reachable": reach.get("workable_reachable"),
            "venue_silent": [s["venue"] for s in _arm(v, "venue_silence").get("silent", [])],
            "venues_evaluated": _arm(v, "venue_silence").get("evaluated"),
            "matured_total": v["matured_total"],
            "stamped_total": v["stamped_total"],
            "emitted_recent": v["emitted_recent"],
        }
        ok, detail = canary_result_log.append_result(
            CANARY_NAME, v["verdict"], exit_code, metrics, path=path)
        log("CANARY_RESULT_LOG=%s" % detail if ok else "CANARY_RESULT_LOG_FAILED=%s" % detail)
    except Exception as e:  # noqa: BLE001 — a logging bug must never become a paging bug
        log("CANARY_RESULT_LOG_FAILED=%s: %s" % (type(e).__name__, e))


def run(inputs, now):
    v = classify(inputs, now)
    # Each alert keeps its own streaks. A heal resets the streak to 0 rather than decaying it; an
    # INDETERMINATE run HOLDS both streaks — a run that could not evaluate is evidence of nothing
    # in either direction, and letting it accumulate would page on two unreadable runs.
    parent, venue = v["parent_verdict"], v["venue_verdict"]
    prior, recovery = read_streak(), read_recovery_streak()
    streak = prior + 1 if parent == "FAIL" else (0 if parent == "PASS" else prior)
    if parent == "PASS":
        recovery += 1
    elif parent == "FAIL":
        recovery = 0
    vs_prior, vs_recovery = read_vs_streak(), read_vs_recovery()
    vs_streak = vs_prior + 1 if venue == "FAIL" else (0 if venue == "PASS" else vs_prior)
    if venue == "PASS":
        vs_recovery += 1
    elif venue == "FAIL":
        vs_recovery = 0

    log(census_source_line(v))
    for line in render_eval_lines(v, streak, vs_streak):
        log(line)

    # The resolution gates PROJECT from the wrapper's markers (episode_open) — the record of a
    # delivered page that cannot drift from the wrapper. The recovery streaks are deliberately NOT
    # reset by a clear: the marker disappearing is what stops further clears, and a resolution the
    # wrapper could not deliver (it keeps the marker to retry) is retried on the next healthy run.
    will_page = v["breach"] and streak >= CONSECUTIVE_TO_PAGE
    will_clear = parent == "PASS" and episode_open(ALERT_ID) and recovery >= CONSECUTIVE_TO_PAGE
    vs_page = v["venue_breach"] and vs_streak >= CONSECUTIVE_TO_PAGE
    vs_clear = (venue == "PASS" and episode_open(VENUE_SILENT_ALERT)
                and vs_recovery >= CONSECUTIVE_TO_PAGE)

    write_state(streak, v, now, recovery, vs_streak, vs_recovery)

    if will_page:
        fire(build_body(v, streak))
    elif v["breach"]:
        log("BREACH_DAY_1: sustained-drift gate holds the page until streak %d"
            % CONSECUTIVE_TO_PAGE)
    elif will_clear:
        clear("outcome-backfill healthy on %d consecutive checks (arms 1-3 PASS)" % recovery)
    elif parent == "PASS" and episode_open(ALERT_ID):
        log("RECOVERY_HOLD: %d/%d consecutive PASS — a resolution needs the same sustain the "
            "page needed" % (recovery, CONSECUTIVE_TO_PAGE))

    if vs_page:
        fire_venue_silent(build_venue_body(v, vs_streak))
    elif v["venue_breach"]:
        log("VENUE_SILENT_DAY_1: sustained-drift gate holds the page until streak %d"
            % CONSECUTIVE_TO_PAGE)
    elif vs_clear:
        clear_venue_silent("every venue filled what it attempted on %d consecutive checks"
                           % vs_recovery)
    elif venue == "PASS" and episode_open(VENUE_SILENT_ALERT):
        log("VENUE_SILENT_RECOVERY_HOLD: %d/%d consecutive PASS" % (vs_recovery, CONSECUTIVE_TO_PAGE))
    return v, streak


def main():
    try:
        now = now_epoch()
        v, _ = run(gather(now), now)
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
    """Hermetic scenarios — no DB, no wrapper, no emitter, temp state.

    Two-way by construction: every FAIL case has a HEALTHY twin differing in ONE input.

    The hermetic seams replace psql and the emitter, so the artifacts they bypass are asserted
    directly: the SQL this file still builds, every PARSER (a NULL stamp, a NULL frontier, a psql
    SET tag, an emitter that lies), the runtime refusals of emitted SQL, both rendered BODIES, the
    R6 recorder's inertness and the token->exit-code mapping — and `gather()` itself, through fake
    psql and emitter commands. The REAL emitter's JSON and the REAL census SQL's output are fed
    through these same parsers by tests/unit/backfill-census-single-derivation.test.ts. Assertions
    that would RAISE are wrapped — an assertion that aborts the suite is a crash, not a failure.
    """
    global STATE_FILE, LOG, ALERT_STATE_DIR
    tmp = tempfile.mkdtemp(prefix="outcome-backfill-selftest-")
    STATE_FILE = os.path.join(tmp, "state.json")
    LOG = os.path.join(tmp, "selftest.log")
    # The wrapper's marker dir, redirected — a self-test must never read or touch PRODUCTION alert
    # state, and episode_open() reads that directory.
    ALERT_STATE_DIR = os.path.join(tmp, "alert-state")
    os.makedirs(ALERT_STATE_DIR, exist_ok=True)
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
    LIMIT = 5000
    # A FIXTURE standing in for the emitter's horizons — the real map is pinned against
    # maturityHorizonS by the vitest, never by this hermetic suite.
    HORIZONS = {"1m": 780, "3m": 2340, "5m": 3900, "15m": 11700, "30m": 16200, "1h": 32400,
                "2h": 50400, "4h": 100800, "8h": 144000, "12h": 216000, "1d": 345600}
    VEXPR = "COALESCE(NULLIF(exchange,''),'HL')"
    CLAUSE = "((%s = 'HL' AND timeframe = '5m' AND created_at < %d))" % (VEXPR, NOW - 1496304)

    def emission(limit=LIMIT, clause=CLAUSE, census_sql=None, venue_sql=None, sha="0" * 40):
        return {"census_sql": census_sql if census_sql is not None else
                "SELECT COUNT(*) AS backlog_uncapped FROM signals WHERE outcome_price IS NULL "
                "AND NOT " + clause,
                "venue_sql": venue_sql if venue_sql is not None else
                "SELECT %s AS venue FROM signals GROUP BY 1" % VEXPR,
                "past_reach_clause": clause, "horizons_s": dict(HORIZONS),
                "constants": {"limit": limit, "max_attempts": 3, "cooldown_s": 86400,
                              "reach_margin_s": 3600},
                "reach_measured_at": "2026-09-27", "source_sha": sha}

    def producer(filled_lag_h=0.1, emitted=100, matured=467094, stamped=467094):
        return {"newest_filled": None if filled_lag_h is None else int(NOW - filled_lag_h * H),
                "stamped_total": stamped, "matured_total": matured, "emitted_recent": emitted}

    def census(backlog=900, frontier_lag_h=0.5, parked=100, immature=0, past_reach=0,
               servable=None):
        return {"backlog_uncapped": backlog, "immature": immature, "parked": parked,
                "past_reach": past_reach,
                "servable_uncapped": servable if servable is not None else max(0, backlog - immature - parked - past_reach),
                "frontier": None if frontier_lag_h is None else int(NOW - frontier_lag_h * H)}

    def venue(name, matured=50, filled=50, attempted=2, crossed=0, servable=3):
        return {"venue": name, "matured_24h": matured, "filled_24h": filled,
                "attempted_24h": attempted, "past_reach_entered_24h": crossed, "servable": servable}

    def pop(lanes=(("3m", 500, 0.6), ("5m", 400, 1.0), ("1h", 200, 8.0))):
        return [{"timeframe": tf, "emitted": e,
                 "max_matured": None if lag is None else int(NOW - lag * H)}
                for tf, e, lag in lanes]

    HEALTHY_VENUES = [venue("BINANCE"), venue("HL", crossed=4)]

    def inp(p="d", c="d", vs="d", pp="d", em="d", census_error=None, producer_error=None,
            population_error=None):
        return {"producer": producer() if p == "d" else p,
                "producer_error": producer_error,
                "emission": emission() if em == "d" else em,
                "census": census() if c == "d" else c,
                "venues": list(HEALTHY_VENUES) if vs == "d" else vs,
                "census_error": census_error,
                "population": pop() if pp == "d" else pp,
                "population_error": population_error}

    # ── ARM 1: the PRODUCER arm (its own direct read) ────────────────────────────────────────
    check("arm1 PASS: fresh producer stamp + input flowing",
          lambda: arm_producer(producer(filled_lag_h=0.1), NOW)["verdict"] == "PASS")
    check("arm1 FAIL: stale producer stamp + input flowing",
          lambda: arm_producer(producer(filled_lag_h=STALE_HOURS + 1), NOW)["verdict"] == "FAIL")
    check("arm1 TWIN: same stale stamp but NO input -> PASS (seed-coverage's subject, not ours)",
          lambda: arm_producer(producer(filled_lag_h=STALE_HOURS + 1, emitted=0), NOW)["verdict"]
          == "PASS")
    check("arm1 TWIN: exactly AT the threshold is healthy (boundary is >, not >=)",
          lambda: arm_producer(producer(filled_lag_h=STALE_HOURS), NOW)["verdict"] == "PASS")
    check("arm1 NULL BOOTSTRAP -> INDETERMINATE, never PASS (fail-open) and never FAIL (page)",
          lambda: arm_producer(producer(filled_lag_h=None, stamped=0), NOW)["verdict"]
          == "INDETERMINATE")
    check("arm1 says BOOTSTRAP in words, so deploy-night INDETERMINATE is legible not mysterious",
          lambda: "BOOTSTRAP" in arm_producer(producer(filled_lag_h=None, stamped=0), NOW)["detail"])
    check("arm1 the first stamped row RESOLVES the bootstrap to PASS",
          lambda: arm_producer(producer(filled_lag_h=0.01, stamped=1), NOW)["verdict"] == "PASS")
    check("arm1 reports the lag as a number, not just the boolean",
          lambda: abs(arm_producer(producer(filled_lag_h=5), NOW)["lag_h"] - 5.0) < 0.01)
    check("arm1 keys on outcome_filled_at, NOT on created_at (the whole point of the re-key)",
          lambda: "MAX(outcome_filled_at)" in build_producer_sql(NOW)
          and "MAX(created_at) FILTER" not in build_producer_sql(NOW))

    # ── ARM 2: POPULATION + the identifiability guard, on the emitter's horizons ─────────────
    check("arm2 PASS: every emitting lane matured inside its OWN horizon",
          lambda: arm_population(pop(), NOW, HORIZONS)["verdict"] == "PASS")
    check("arm2 judges a slow lane against its OWN horizon, not the global threshold",
          lambda: arm_population(pop((("3m", 100, 0.6), ("1d", 5, 90.0))), NOW, HORIZONS)["verdict"]
          == "PASS")
    check("arm2 uses the lane's horizon as a TERM, not just as an identifiability filter: a 1h "
          "lane (horizon 9h) at 15h lag is PASS, though 15h exceeds the 12h global threshold",
          lambda: arm_population(pop((("1h", 200, 15.0),)), NOW, HORIZONS)["verdict"] == "PASS"
          and arm_population(pop((("1h", 200, 22.0),)), NOW, HORIZONS)["verdict"] == "FAIL")
    check("arm2 FAIL: a FAST lane stalled far beyond its own horizon (the 2026-09-05 shape)",
          lambda: arm_population(pop((("3m", 500, 40.0), ("5m", 400, 40.0))), NOW, HORIZONS)["verdict"]
          == "FAIL")
    check("arm2 TWIN: the same lanes, fresh -> PASS",
          lambda: arm_population(pop((("3m", 500, 0.6), ("5m", 400, 1.0))), NOW, HORIZONS)["verdict"]
          == "PASS")
    check("arm2 NOT_IDENTIFIABLE -> INDETERMINATE when every emitting lane out-matures the "
          "threshold (a threshold an arm cannot attain is a level test in a delta's clothes)",
          lambda: arm_population(pop((("4h", 50, 30.0), ("1d", 5, 100.0))), NOW, HORIZONS)["verdict"]
          == "INDETERMINATE")
    check("arm2 NOT_IDENTIFIABLE says so IN WORDS, so the refusal is legible in the log",
          lambda: "NOT_IDENTIFIABLE" in arm_population(pop((("4h", 50, 30.0),)), NOW, HORIZONS)["detail"])
    check("arm2 INDETERMINATE on an empty population, never a verdict over nothing",
          lambda: arm_population([], NOW, HORIZONS)["verdict"] == "INDETERMINATE")
    check("arm2 ignores a lane that is not emitting (it cannot pin a high-water mark)",
          lambda: arm_population(pop((("3m", 500, 0.6), ("1d", 0, 900.0))), NOW, HORIZONS)["verdict"]
          == "PASS")
    check("arm2 FAIL when an emitting fast lane has NEVER matured",
          lambda: arm_population(pop((("3m", 500, None),)), NOW, HORIZONS)["verdict"] == "FAIL")
    check("arm2 names every lane it judged, with that lane's own horizon",
          lambda: "3m(h=0.65" in arm_population(pop((("3m", 500, 0.6),)), NOW, HORIZONS)["detail"])
    check("arm2 a timeframe the producer has no horizon for is never silently given one",
          lambda: arm_population(pop((("7s", 500, 900.0), ("3m", 500, 0.6))), NOW, HORIZONS)["verdict"]
          == "PASS"
          and "7s" not in arm_population(pop((("7s", 500, 900.0), ("3m", 500, 0.6))), NOW, HORIZONS)["detail"])
    check("arm2 reads the horizons it is HANDED — a different producer map changes the verdict",
          lambda: arm_population(pop((("1h", 200, 15.0),)), NOW, dict(HORIZONS, **{"1h": 3600}))["verdict"]
          == "FAIL")

    # ── ARM 3: REACHABILITY on the producer's own census ─────────────────────────────────────
    check("arm3 PASS: workable under cap, frontier fresh, parked cohort bounded",
          lambda: arm_reachability(census(), NOW, LIMIT)["verdict"] == "PASS")
    check("arm3 3a is keyed on raw − immature − past_reach (both EXOGENOUS)",
          lambda: arm_reachability(census(backlog=6000, immature=1500, past_reach=500), NOW, LIMIT)
          ["workable_reachable"] == 4000)
    check("arm3 keeps reporting `workable` = raw − immature under its OLD name (series continuity)",
          lambda: arm_reachability(census(backlog=6000, immature=1500, past_reach=500), NOW, LIMIT)
          ["workable"] == 4500)
    check("arm3 FAIL: WORKABLE at the producer's cap",
          lambda: arm_reachability(census(backlog=LIMIT, immature=0), NOW, LIMIT)["verdict"] == "FAIL")
    check("arm3 TWIN: one workable row under the cap -> PASS",
          lambda: arm_reachability(census(backlog=LIMIT - 1, immature=0), NOW, LIMIT)["verdict"]
          == "PASS")
    check("arm3 the cap is the PRODUCER's (emitter constant), never a local literal",
          lambda: arm_reachability(census(backlog=4000), NOW, 3000)["verdict"] == "FAIL"
          and arm_reachability(census(backlog=4000), NOW, 5000)["verdict"] == "PASS")
    check("arm3 THE 2026-10-10 SHAPE: past-reach rows covering the excess PASS 3a",
          lambda: arm_reachability(census(backlog=9434, immature=3833, past_reach=2570, parked=3281),
                                   NOW, LIMIT)["verdict"] == "PASS")
    check("arm3 TWIN: the same backlog with NO past-reach rows FAILS 3a (the pre-CH1 page)",
          lambda: arm_reachability(census(backlog=9434, immature=3833, past_reach=0, parked=3281),
                                   NOW, LIMIT)["verdict"] == "FAIL")
    check("arm3 a LARGE raw backlog that is mostly NOT YET DUE is not a starvation",
          lambda: arm_reachability(census(backlog=9000, immature=4600), NOW, LIMIT)["verdict"] == "PASS")
    check("arm3 THE ENDOGENEITY LAW: a large PARKED cohort does NOT make the arm greener",
          lambda: arm_reachability(census(backlog=6000, immature=0, parked=4000), NOW, LIMIT)
          ["workable_reachable"] == 6000
          and arm_reachability(census(backlog=6000, immature=0, parked=4000), NOW, LIMIT)["verdict"]
          == "FAIL")
    check("arm3 FAIL: queue frontier older than the threshold",
          lambda: arm_reachability(census(frontier_lag_h=STALE_HOURS + 1), NOW, LIMIT)["verdict"]
          == "FAIL")
    check("arm3 TWIN: frontier exactly at the threshold is healthy",
          lambda: arm_reachability(census(frontier_lag_h=STALE_HOURS), NOW, LIMIT)["verdict"] == "PASS")
    check("arm3 an EMPTY frontier is the BEST case (no pending work), never an error",
          lambda: arm_reachability(census(frontier_lag_h=None), NOW, LIMIT)["verdict"] == "PASS")
    check("arm3c FAIL when the PARKED cohort alone would fill the window",
          lambda: arm_reachability(census(parked=LIMIT), NOW, LIMIT)["verdict"] == "FAIL")
    check("arm3c TWIN: one under the cap -> PASS",
          lambda: arm_reachability(census(parked=LIMIT - 1), NOW, LIMIT)["verdict"] == "PASS")
    check("arm3 reports raw, immature, past_reach, workable, servable_uncapped, ratio, frontier and "
          "parked ALWAYS",
          lambda: all(k in arm_reachability(census(), NOW, LIMIT)["detail"]
                      for k in ("workable_reachable=", "raw=", "immature=", "past_reach=",
                                "workable=", "servable_uncapped=", "ratio=",
                                "queue_frontier_age_h=", "parked=")))
    check("arm3 names WHICH sub-check failed, never a bare FAIL",
          lambda: "FAILING: workable_within_cap" in
          arm_reachability(census(backlog=LIMIT), NOW, LIMIT)["detail"])

    # ── ARM 3d: VENUE SILENCE, twins at N_MIN and N_MIN − 1 ──────────────────────────────────
    check("arm3d FAIL: matured >= N_MIN, filled 0, attempted > 0 — the adapter is failing",
          lambda: arm_venue_silence([venue("XT", matured=VENUE_SILENT_N_MIN, filled=0, attempted=1)])
          ["verdict"] == "FAIL")
    check("arm3d TWIN at N_MIN − 1: the same venue with fewer matured rows is PASS",
          lambda: arm_venue_silence([venue("XT", matured=VENUE_SILENT_N_MIN - 1, filled=0,
                                           attempted=1)])["verdict"] == "PASS")
    check("arm3d TWIN: one fill clears it — a venue that fills something is not silent",
          lambda: arm_venue_silence([venue("XT", matured=40, filled=1, attempted=9)])["verdict"]
          == "PASS")
    check("arm3d TWIN: zero attempts is starvation or thinness, not an adapter failure",
          lambda: arm_venue_silence([venue("XT", matured=40, filled=0, attempted=0)])["verdict"]
          == "PASS")
    check("arm3d a retired venue retrying old rows (matured 0) never pages — the BITMART day",
          lambda: arm_venue_silence([venue("BITMART", matured=0, filled=0, attempted=67)])["verdict"]
          == "PASS")
    check("arm3d zero venues is a reported FACT, never a silent pass",
          lambda: arm_venue_silence([])["verdict"] == "PASS"
          and "a FACT" in arm_venue_silence([])["detail"])
    check("arm3d names every silent venue with its counts",
          lambda: "XT(matured=9 filled=0 attempted=4)" in
          arm_venue_silence([venue("XT", matured=9, filled=0, attempted=4), venue("HL")])["detail"])
    check("arm3d reports the flow through the exit (rows crossing their venue's depth in 24 h)",
          lambda: "past_reach_entered_24h=4" in arm_venue_silence(HEALTHY_VENUES)["detail"])

    # ── the composition rule ─────────────────────────────────────────────────────────────────
    check("aggregate precedence is FAIL > INDETERMINATE > PASS",
          lambda: aggregate(["PASS", "INDETERMINATE", "FAIL"]) == "FAIL"
          and aggregate(["PASS", "INDETERMINATE"]) == "INDETERMINATE"
          and aggregate(["PASS", "PASS"]) == "PASS")
    check("aggregate over NOTHING is INDETERMINATE, never PASS",
          lambda: aggregate([]) == "INDETERMINATE")
    check("THE REGRESSION THIS CANARY EXISTS TO PREVENT: a healthy producer beside an unreachable "
          "queue is a FAIL, never a PASS",
          lambda: classify(inp(c=census(backlog=LIMIT + 6800, frontier_lag_h=11.3)), NOW)["verdict"]
          == "FAIL")
    check("...and the arms name WHICH half broke (producer PASS, reachability FAIL)",
          lambda: [a["verdict"] for a in classify(
              inp(c=census(backlog=LIMIT + 6800, frontier_lag_h=11.3)), NOW)["arms"]]
          == ["PASS", "PASS", "FAIL", "PASS"])
    check("a fully healthy estate is PASS on all four arms",
          lambda: classify(inp(), NOW)["verdict"] == "PASS"
          and [a["name"] for a in classify(inp(), NOW)["arms"]]
          == ["producer", "population", "reachability", "venue_silence"])
    check("a silent venue FAILS the token but NOT the parent alert — one alert id, one remedy",
          lambda: classify(inp(vs=[venue("XT", matured=5, filled=0, attempted=3)]), NOW)["verdict"]
          == "FAIL"
          and classify(inp(vs=[venue("XT", matured=5, filled=0, attempted=3)]), NOW)["parent_verdict"]
          == "PASS")

    # ── EMITTER FAILURE: arms 2-3 INDETERMINATE while arm 1 evaluates ────────────────────────
    blind = inp(c=None, vs=None, pp=None, em=None, census_error="the census emitter failed rc=1",
                population_error="no horizons — the census emitter did not answer")
    check("emitter failure ⇒ population, reachability and venue arms INDETERMINATE",
          lambda: [a["verdict"] for a in classify(blind, NOW)["arms"][1:]]
          == ["INDETERMINATE", "INDETERMINATE", "INDETERMINATE"])
    check("emitter failure ⇒ arm 1 STILL evaluates (PASS on a healthy producer)",
          lambda: classify(blind, NOW)["arms"][0]["verdict"] == "PASS")
    check("emitter failure ⇒ a stale producer still FAILS — the emitter can never blind arm 1",
          lambda: classify(dict(blind, producer=producer(filled_lag_h=STALE_HOURS + 1)), NOW)
          ["parent_verdict"] == "FAIL")
    check("emitter failure ⇒ the token is never PASS",
          lambda: classify(blind, NOW)["verdict"] == "INDETERMINATE")
    check("emitter failure ⇒ the INDETERMINATE arms say WHY in words",
          lambda: "the census emitter failed" in classify(blind, NOW)["arms"][2]["detail"])
    check("CENSUS_SOURCE names the stand-in it did NOT use: unavailable + reason",
          lambda: census_source_line(classify(blind, NOW)).startswith("CENSUS_SOURCE=unavailable reason=")
          and census_source_line(classify(inp(), NOW)).startswith(
              "CENSUS_SOURCE=emitter source_sha=" + "0" * 40))
    check("a producer-read failure blinds ONLY arm 1",
          lambda: [a["verdict"] for a in classify(inp(p=None, producer_error="psql failed rc=2"), NOW)["arms"]]
          == ["INDETERMINATE", "PASS", "PASS", "PASS"])

    # ── the SQL strings this file still builds ───────────────────────────────────────────────
    psql_sql = build_producer_sql(NOW)
    check("producer SQL is read-only by construction",
          lambda: psql_sql.startswith("SET default_transaction_read_only=on;"))
    check("producer SQL carries the integer input window (created_at is an epoch int)",
          lambda: "created_at > %d" % (NOW - INPUT_WINDOW_HOURS * H) in psql_sql)
    check("producer SQL touches pfe_return_pct ONLY as IS NOT NULL (label-blind)",
          lambda: psql_sql.count("pfe_return_pct") == 1 and "pfe_return_pct IS NOT NULL" in psql_sql)
    check("population SQL is read-only, groups by timeframe and encodes 'never matured' as -1",
          lambda: build_population_sql(NOW).startswith("SET default_transaction_read_only=on;")
          and "GROUP BY timeframe" in build_population_sql(NOW)
          and "COALESCE(MAX(created_at) FILTER (WHERE pfe_return_pct IS NOT NULL), -1)"
          in build_population_sql(NOW))
    check("neither SQL leaves a %-format or LIKE wildcard unresolved (a sibling's live-run bug)",
          lambda: "%" not in psql_sql and "%" not in build_population_sql(NOW))
    check("no SQL this file builds reads an outcome VALUE — cardinalities and timestamps only",
          lambda: all(t not in psql_sql and t not in build_population_sql(NOW)
                      for t in ("outcome_return_pct", "mae_return_pct", "pfe_price")))
    check("ro() wraps ONE statement in a read-only transaction, never doubling a separator",
          lambda: ro("SELECT 1") == "SET default_transaction_read_only=on; SELECT 1;"
          and ro("SELECT 1;") == "SET default_transaction_read_only=on; SELECT 1;")

    # ── the PARSERS the hermetic seams bypass ────────────────────────────────────────────────
    prow = "1786599000|467094|467094|577"
    check("producer parser reads a 4-field psql -tA row",
          lambda: parse_producer(prow)["emitted_recent"] == 577)
    check("producer parser skips the SET command tag before the data row",
          lambda: parse_producer("SET\n" + prow)["stamped_total"] == 467094)
    check("producer parser accepts an EMPTY stamp as None (the bootstrap FACT, not vacuity)",
          lambda: parse_producer("|0|0|577")["newest_filled"] is None)

    def raises_indeterminate(fn):
        try:
            fn()
        except Indeterminate:
            return True
        except Exception:  # noqa: BLE001
            return False
        return False

    check("producer parser: empty output -> INDETERMINATE (handed input we could not parse)",
          lambda: raises_indeterminate(lambda: parse_producer("")))
    check("producer parser: a non-numeric row -> INDETERMINATE, never a silent 0",
          lambda: raises_indeterminate(lambda: parse_producer("a|b|c|d")))
    check("producer parser: wrong field count -> INDETERMINATE",
          lambda: raises_indeterminate(lambda: parse_producer("1|2|3")))
    check("population parser reads rows and decodes -1 as 'never matured'",
          lambda: parse_population("3m|500|1786599000\n1d|5|-1")[1]["max_matured"] is None)
    check("population parser returns [] on empty output — a FACT the arm then refuses over",
          lambda: parse_population("") == [])
    crow = "9434|3833|3281|2570|2320|1786598000"
    check("census parser reads the emitter census's 6-field row in CENSUS_COLUMNS order",
          lambda: parse_emitter_census("SET\n" + crow) == dict(zip(CENSUS_COLUMNS,
                                                                    [9434, 3833, 3281, 2570, 2320, 1786598000])))
    check("census parser accepts an EMPTY frontier as None (nothing servable, the best case)",
          lambda: parse_emitter_census("SET\n0|0|0|0|0|")["frontier"] is None)
    check("census parser: a missing count -> INDETERMINATE (only the frontier may be empty)",
          lambda: raises_indeterminate(lambda: parse_emitter_census("9434||3281|2570|2320|1")))
    check("census parser: wrong field count -> INDETERMINATE",
          lambda: raises_indeterminate(lambda: parse_emitter_census("1|2|3|4|5")))
    check("census parser: two rows where one was promised -> INDETERMINATE",
          lambda: raises_indeterminate(lambda: parse_emitter_census(crow + "\n" + crow)))
    check("census parser: no row at all -> INDETERMINATE (handed nothing we can count)",
          lambda: raises_indeterminate(lambda: parse_emitter_census("SET\n")))
    vrows = "SET\nBINANCE|50|50|2|0|3\nHL|40|38|9|4|12"
    check("venue parser reads VENUE_COLUMNS rows",
          lambda: parse_venue_rows(vrows)[1] == {"venue": "HL", "matured_24h": 40, "filled_24h": 38,
                                                 "attempted_24h": 9, "past_reach_entered_24h": 4,
                                                 "servable": 12})
    check("venue parser: zero rows is a FACT, []",
          lambda: parse_venue_rows("SET\n") == [])
    check("venue parser: a malformed row -> INDETERMINATE",
          lambda: raises_indeterminate(lambda: parse_venue_rows("HL|40|x|9|4|12"))
          and raises_indeterminate(lambda: parse_venue_rows("HL|40|38")))

    def emitted(em_dict=None, token="PASS", extra=""):
        return "%s\n%s=%s\n%s" % (json.dumps(em_dict if em_dict is not None else emission()),
                                  EMIT_TOKEN, token, extra)

    check("emission parser reads the emitter's one JSON line + PASS token",
          lambda: parse_emission(emitted())["constants"]["limit"] == LIMIT)
    check("emission parser: an INDETERMINATE token -> INDETERMINATE, whatever JSON came with it",
          lambda: raises_indeterminate(lambda: parse_emission(emitted(token="INDETERMINATE"))))
    check("emission parser: no token at all -> INDETERMINATE",
          lambda: raises_indeterminate(lambda: parse_emission(json.dumps(emission()))))
    check("emission parser: two JSON lines -> INDETERMINATE",
          lambda: raises_indeterminate(lambda: parse_emission(json.dumps(emission()) + "\n" + emitted())))
    check("emission parser: a missing key -> INDETERMINATE (every key the canary reads must arrive)",
          lambda: all(raises_indeterminate(lambda k=k: parse_emission(emitted(
              {kk: vv for kk, vv in emission().items() if kk != k}))) for k in EMITTER_KEYS))
    check("emission parser: a boolean or zero constant -> INDETERMINATE",
          lambda: raises_indeterminate(lambda: parse_emission(emitted(dict(emission(), constants={
              "limit": True, "max_attempts": 3, "cooldown_s": 86400, "reach_margin_s": 3600}))))
          and raises_indeterminate(lambda: parse_emission(emitted(dict(emission(), constants={
              "limit": 0, "max_attempts": 3, "cooldown_s": 86400, "reach_margin_s": 3600})))))
    check("emission parser: an empty horizon map -> INDETERMINATE",
          lambda: raises_indeterminate(lambda: parse_emission(emitted(dict(emission(), horizons_s={})))))
    check("emitted SQL: a clean emission has no problems",
          lambda: emitted_sql_problems(emission()) == [])
    check("RIDER 4 AT RUNTIME: a past-reach clause naming an attempt column is REFUSED",
          lambda: any("RIDER 4" in p for p in emitted_sql_problems(emission(
              clause=CLAUSE.replace("created_at <", "outcome_attempts >= 3 AND created_at <")))))
    check("emitted SQL: the audited clause must be the one the census executes",
          lambda: any("not the one the census executes" in p for p in emitted_sql_problems(
              emission(census_sql="SELECT COUNT(*) AS backlog_uncapped FROM signals"))))
    check("emitted SQL: an outcome VALUE column is REFUSED (label-blind on the live SQL)",
          lambda: any("label-blind" in p for p in emitted_sql_problems(emission(
              venue_sql="SELECT AVG(outcome_return_pct) FROM signals"))))
    check("emitted SQL: a statement separator is REFUSED",
          lambda: any("separator" in p for p in emitted_sql_problems(emission(
              venue_sql="SELECT 1; DELETE FROM signals"))))

    # ── gather() through fake psql + emitter commands — the seams themselves ─────────────────
    fake_psql = os.path.join(tmp, "fake-psql.py")
    with open(fake_psql, "w") as fh:
        fh.write("import sys\nsql = sys.argv[-1]\n"
                 "if 'backlog_uncapped' in sql: print('SET'); print('%s')\n"
                 "elif ' AS venue' in sql: print('SET'); print('BINANCE|50|50|2|0|3')\n"
                 "elif 'GROUP BY timeframe' in sql: print('SET'); print('3m|500|%d')\n"
                 "else: print('SET'); print('%s')\n" % (crow, NOW - 2000, prow))
    fake_emitter = os.path.join(tmp, "fake-emitter.py")
    with open(fake_emitter, "w") as fh:
        fh.write("import sys\nprint(%r)\nprint(%r)\n" % (json.dumps(emission()), EMIT_TOKEN + "=PASS"))
    saved_env = {k: os.environ.get(k) for k in ("OBF_PSQL_CMD", "OBF_EMITTER_CMD")}
    try:
        os.environ["OBF_PSQL_CMD"] = "%s %s" % (sys.executable, fake_psql)
        os.environ["OBF_EMITTER_CMD"] = "%s %s {now}" % (sys.executable, fake_emitter)
        g_ok = gather(NOW)
        os.environ["OBF_EMITTER_CMD"] = "false"   # the emitter exits 1 and prints nothing
        g_dead = gather(NOW)
    finally:
        for k, val in saved_env.items():
            if val is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = val
    check("gather(): a working emitter + psql yields every input, no errors",
          lambda: g_ok["census"]["past_reach"] == 2570 and g_ok["venues"][0]["venue"] == "BINANCE"
          and g_ok["population"][0]["timeframe"] == "3m" and g_ok["producer"]["emitted_recent"] == 577
          and not any(g_ok[k] for k in ("producer_error", "census_error", "population_error")))
    check("gather(): a DEAD emitter leaves the producer read intact and blinds the rest, with reasons",
          lambda: g_dead["producer"] is not None and g_dead["emission"] is None
          and g_dead["census"] is None and "rc=1" in (g_dead["census_error"] or "")
          and "did not answer" in (g_dead["population_error"] or ""))
    check("gather() → classify(): the dead-emitter run is INDETERMINATE with arm 1 still PASS",
          lambda: classify(g_dead, NOW)["verdict"] == "INDETERMINATE"
          and classify(g_dead, NOW)["arms"][0]["verdict"] == "PASS")

    # ── sustained-drift gate: day 1 holds, day 2 pages, a heal RESETS ────────────────────────
    LAST_FIRE.clear()
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
    bad = inp(p=producer(filled_lag_h=STALE_HOURS + 1))
    _, s1 = run(bad, NOW)
    check("breach day 1 -> streak 1, NO page (sustained-drift gate)",
          lambda: s1 == 1 and not LAST_FIRE)
    _, s2 = run(bad, NOW)
    check("breach day 2 -> streak 2, PAGES", lambda: s2 == 2 and "body" in LAST_FIRE)
    body = LAST_FIRE.get("body", "")
    LAST_FIRE.clear()
    _, s3 = run(inp(), NOW)
    check("a HEAL resets the streak to 0 and pages nothing",
          lambda: s3 == 0 and not LAST_FIRE)
    _, s4 = run(bad, NOW)
    check("after a heal, the NEXT single breach is day 1 again (no carried partial streak)",
          lambda: s4 == 1 and not LAST_FIRE)
    LAST_FIRE.clear()
    _, s5 = run(inp(p=producer(filled_lag_h=None, stamped=0)), NOW)
    check("an INDETERMINATE run HOLDS the streak — it is not evidence of sustained drift",
          lambda: s5 == s4 and not LAST_FIRE)
    check("every run logs its CENSUS_SOURCE line",
          lambda: "CENSUS_SOURCE=emitter source_sha=" in open(LOG).read())

    # ── SYMMETRIC HYSTERESIS on the way out (the condition on announce_resolution: true) ─────
    marker = os.path.join(ALERT_STATE_DIR, "%s-last-fired-at" % ALERT_ID)
    vs_marker = os.path.join(ALERT_STATE_DIR, "%s-last-fired-at" % VENUE_SILENT_ALERT)

    def wrapper_delivers_fire():
        if LAST_FIRE:
            with open(marker, "w") as fh:
                fh.write(str(NOW))

    def wrapper_delivers_clear():
        if LAST_CLEAR and os.path.exists(marker):
            os.remove(marker)

    def fresh():
        for d in (LAST_FIRE, LAST_CLEAR, LAST_VS_FIRE, LAST_VS_CLEAR):
            d.clear()
        for p in (STATE_FILE, marker, vs_marker):
            if os.path.exists(p):
                os.remove(p)

    fresh()
    run(bad, NOW)                       # day 1 — held
    run(bad, NOW)                       # day 2 — PAGES
    check("the canary writes NO page memory of its own — before the wrapper delivers, nothing is open",
          lambda: "body" in LAST_FIRE and episode_open() is False)
    wrapper_delivers_fire()
    check("resolution precondition: a DELIVERED page leaves the wrapper's marker, and the gate sees it",
          lambda: episode_open() is True)
    LAST_CLEAR.clear()
    run(inp(), NOW)                     # first PASS
    check("ONE healthy check after a page does NOT announce a resolution (flap guard)",
          lambda: not LAST_CLEAR and episode_open() is True)
    check("...and the hold is REPORTED, so an un-announced recovery is never silent-by-accident",
          lambda: "RECOVERY_HOLD: 1/2" in open(LOG).read())
    run(inp(), NOW)                     # second consecutive PASS -> announce
    check("TWO consecutive healthy checks dispatch exactly ONE resolution",
          lambda: "reason" in LAST_CLEAR)
    wrapper_delivers_clear()
    LAST_CLEAR.clear()
    run(inp(), NOW)                     # third PASS -> nothing more
    check("a third healthy check dispatches NOTHING once the wrapper removed its marker — "
          "one resolution per delivered episode",
          lambda: not LAST_CLEAR)
    fresh()
    run(inp(), NOW)
    run(inp(), NOW)
    check("healthy checks with NO delivered page announce nothing — recovery chatter stays off",
          lambda: not LAST_CLEAR)
    fresh()
    run(bad, NOW)
    run(bad, NOW)                       # paged
    wrapper_delivers_fire()
    LAST_CLEAR.clear()
    run(inp(), NOW)                     # PASS 1
    run(inp(p=producer(filled_lag_h=None, stamped=0)), NOW)   # INDETERMINATE — holds
    check("an INDETERMINATE between two PASSes HOLDS the recovery streak, never advances it",
          lambda: not LAST_CLEAR and read_recovery_streak() == 1)
    run(inp(), NOW)                     # PASS 2 -> now it announces
    check("...and the very next PASS completes the sustain and announces",
          lambda: "reason" in LAST_CLEAR)
    fresh()
    run(bad, NOW)
    run(bad, NOW)                       # paged
    wrapper_delivers_fire()
    LAST_CLEAR.clear()
    run(inp(), NOW)                     # PASS 1
    run(bad, NOW)                       # FAIL — resets the recovery streak
    run(inp(), NOW)                     # PASS 1 again, not 2
    check("a FAIL between two PASSes RESETS the recovery streak (no announce on a flap)",
          lambda: not LAST_CLEAR and read_recovery_streak() == 1)

    # ── THE INCIDENT, 2026-09-05 -> 2026-09-14 (OPS-DRIFT-ALERT-GENERATORS-W1) ────────────────
    fresh()
    with open(STATE_FILE, "w") as fh:
        json.dump({"consecutive_breaches": 0, "consecutive_pass": 169, "paged": False,
                   "last_verdict": "PASS"}, fh)
    with open(marker, "w") as fh:
        fh.write(str(NOW - 8 * 86400))
    run(inp(), NOW)
    check("🛑 INCIDENT REPLAY: an episode the canary's own state never recorded is CLEARED on the "
          "next healthy run",
          lambda: "reason" in LAST_CLEAR)
    check("...because the gate read the wrapper's marker and IGNORED the stale private `paged: false`",
          lambda: episode_open() is True and read_recovery_streak() == 170)
    wrapper_delivers_clear()
    LAST_CLEAR.clear()
    run(inp(), NOW)
    check("...and once the wrapper removes the marker, healthy runs dispatch nothing further",
          lambda: not LAST_CLEAR and episode_open() is False)
    check("the rewritten state carries no page memory — the wrapper's marker is the only record",
          lambda: "paged" not in json.load(open(STATE_FILE)))

    # ── arm 3d's OWN alert: sustain, literal argv, silent resolution on its own marker ──────
    fresh()
    silent_in = inp(vs=[venue("XT", matured=12, filled=0, attempted=7), venue("HL")])
    run(silent_in, NOW)
    check("venue-silent day 1 -> NO page (same 2-run sustain as the parent)",
          lambda: not LAST_VS_FIRE and read_vs_streak() == 1)
    run(silent_in, NOW)
    check("venue-silent day 2 -> PAGES through the LITERAL argv the registry gate can see",
          lambda: LAST_VS_FIRE.get("argv") == [TG, VENUE_SILENT_ALERT, "CRITICAL_PERSISTENT", "-"])
    check("...and the PARENT alert stays quiet — its arms all passed",
          lambda: not LAST_FIRE and read_streak() == 0)
    vs_body = LAST_VS_FIRE.get("body", "")
    with open(vs_marker, "w") as fh:
        fh.write(str(NOW))
    run(inp(), NOW)
    check("venue-silent: ONE healthy run after a delivered page does not clear (flap guard)",
          lambda: not LAST_VS_CLEAR)
    run(inp(), NOW)
    check("venue-silent: two healthy runs clear — mode flag FIRST, reason positional",
          lambda: (LAST_VS_CLEAR.get("argv") or [None, None, None])[:3]
          == [TG, "--clear", VENUE_SILENT_ALERT])
    fresh()
    run(inp(), NOW)
    run(inp(), NOW)
    check("venue-silent: no delivered page, no clear — recovery chatter stays off",
          lambda: not LAST_VS_CLEAR)

    # ── the rendered BODIES + per-arm lines the seams bypass ─────────────────────────────────
    check("BODY names the alert id", lambda: ALERT_ID in body)
    check("BODY names the PRODUCER, so the remedy points at the right thing",
          lambda: "backfill-outcomes" in body)
    check("BODY carries the recommended wave in TEMPLATE form, never a literal W<N>",
          lambda: RECOMMENDED_WAVE in body and "W{NEXT}" in body)
    check("BODY states the sustain count with its threshold, never a bare number",
          lambda: "Consecutive breaches: 2 (pages at 2)." in body)
    check("BODY names WHICH arm(s) failed, so the operator is not left to guess",
          lambda: "Failing arm(s): producer" in body)
    check("BODY renders all three parent arms, not only the failing one",
          lambda: all(k in body for k in ("producer     :", "reachability :", "population   :")))
    check("BODY projects its cause from the failing check: a stale producer says PRODUCER",
          lambda: "PRODUCER: the backfill has not written for" in body)
    check("BODY carries the census source line",
          lambda: "CENSUS_SOURCE=emitter source_sha=" in body)
    leading = build_body(classify(inp(c=census(backlog=7000, frontier_lag_h=0.7)), NOW), 2)
    check("3a ALONE with a fresh frontier says LEADING — never 'cannot see'",
          lambda: "LEADING: the workable backlog exceeds the window; the frontier is 0.70 h" in leading
          and "cannot see" not in leading.lower())
    blind_body = build_body(classify(inp(c=census(frontier_lag_h=13.0)), NOW), 2)
    check("3b FAILING says the producer cannot see the newest signals",
          lambda: "FRONTIER: the producer cannot see the newest signals" in blind_body)
    both_body = build_body(classify(inp(c=census(backlog=7000, frontier_lag_h=13.0)), NOW), 2)
    check("3a and 3b failing together: FRONTIER plus BACKLOG, never LEADING",
          lambda: "FRONTIER:" in both_body and "BACKLOG:" in both_body and "LEADING" not in both_body)
    parked_body = build_body(classify(inp(c=census(parked=LIMIT)), NOW), 2)
    check("3c FAILING keeps its broken-breaker sentence",
          lambda: "broken at any baseline" in parked_body)
    check("the retired static paragraph is GONE from every body",
          lambda: all("Read the ARMS" not in b and "CANNOT SEE" not in b
                      for b in (body, leading, blind_body, both_body, parked_body)))
    check("VENUE BODY names the venue with its counts and the failing-adapter sentence",
          lambda: "XT: 12 matured, 0 filled, 7 attempted in 24 h — its adapter is failing" in vs_body)
    check("VENUE BODY carries its own template wave and the N_MIN rule",
          lambda: VENUE_SILENT_WAVE in vs_body and "W{NEXT}" in vs_body
          and ">= %d" % VENUE_SILENT_N_MIN in vs_body)
    lines = render_eval_lines(classify(inp(), NOW), 0)
    check("per-check output is POSITIVE and per-ARM — a verdict line and a POPULATION line each",
          lambda: len(lines) == 9 and all(
              any(("ARM %-13s" % n) in ln for ln in lines)
              for n in ("producer", "population", "reachability", "venue_silence")))

    # ── RIDER 4: the generator gate for the population-conflation class ──────────────────────
    #
    # Collected across EVERY state an arm can be in, not just the healthy one: a declaration gate
    # that inspects one branch is the same blindness as a mutation test whose patch never runs.
    all_arms = [a for fixture in (
        inp(),                                                          # healthy
        inp(p=producer(filled_lag_h=STALE_HOURS + 1)),                  # producer FAIL
        inp(p=producer(filled_lag_h=None, stamped=0)),                  # producer INDETERMINATE
        inp(pp=pop((("4h", 50, 30.0),))),                               # population NOT_IDENTIFIABLE
        inp(pp=[]),                                                     # population empty
        inp(c=census(backlog=LIMIT)),                                   # reachability FAIL
        inp(vs=[venue("XT", matured=3, filled=0, attempted=1)]),        # venue FAIL
        blind,                                                          # emitter dead
    ) for a in classify(fixture, NOW)["arms"]]
    check("RIDER 4: EVERY arm declares its population — an undeclared one fails on sight",
          lambda: all(isinstance(a.get("population"), dict)
                      and a["population"].get("counts") for a in all_arms))
    check("RIDER 4: every arm's population line is PRINTED, not merely held in the dict",
          lambda: all(("population arm=%s" % a["name"]) in " ".join(lines) for a in all_arms))
    check("RIDER 4: every declared exclusion carries an EXOGENOUS|ENDOGENOUS tag",
          lambda: all(t in ("EXOGENOUS", "ENDOGENOUS")
                      for a in all_arms
                      for _, t in (a["population"].get("excludes", [])
                                   + a["population"].get("reported_not_subtracted", []))))
    check("RIDER 4 THE LAW: no ENDOGENOUS term is a SUBTRAHEND in any VERDICT INPUT — "
          "a failure population may never shrink the denominator of the thing it is a symptom of",
          lambda: all(t == "EXOGENOUS"
                      for a in all_arms
                      for _, t in a["population"].get("verdict_subtrahends", [])))
    check("RIDER 4 is not vacuous: an ENDOGENOUS term IS present, reported and NOT subtracted",
          lambda: any(("parked", "ENDOGENOUS") in a["population"].get("reported_not_subtracted", [])
                      for a in all_arms)
          and not any(n == "parked" for a in all_arms
                      for n, _ in a["population"].get("verdict_subtrahends", [])))
    check("RIDER 4: past_reach IS a subtrahend, tagged EXOGENOUS",
          lambda: any(("past_reach", "EXOGENOUS") in a["population"].get("verdict_subtrahends", [])
                      for a in all_arms))
    check("per-arm lines carry the measured values, not just verdicts",
          lambda: any("producer_lag_h=" in ln for ln in lines)
          and any("queue_frontier_age_h=" in ln for ln in lines))

    check("INDETERMINATE maps to exit 3, PASS/FAIL to 0",
          lambda: _token_exit_map() == {"PASS": 0, "FAIL": 0, "INDETERMINATE": 3})
    check("every verdict classify can return has an exit code",
          lambda: all(v in _token_exit_map() for v in ("PASS", "FAIL", "INDETERMINATE")))

    # ── R6: the result recorder must never be able to change the verdict ─────────────────────
    def recorder_inert(path):
        v = classify(inp(), NOW)
        before = (v["verdict"], _token_exit_map()[v["verdict"]])
        publish_result(v, before[1], path=path)   # must not raise, must not mutate
        return (v["verdict"], _token_exit_map()[v["verdict"]]) == before
    results = os.path.join(tmp, "results.jsonl")
    check("R6 recorder is INERT on the SUCCESS path — verdict and exit code unchanged, no raise",
          lambda: recorder_inert(results))
    check("R6 recorder is INERT on the FAILURE path too — an unwritable target changes NOTHING",
          lambda: recorder_inert("/proc/definitely-not-writable/results.jsonl"))

    def recorder_inert_when_it_RAISES():
        import types
        boom = types.ModuleType("canary_result_log")

        def _raise(*_a, **_k):
            raise RuntimeError("injected recorder fault")
        boom.append_result = _raise
        saved = sys.modules.get("canary_result_log")
        sys.modules["canary_result_log"] = boom
        try:
            # The fixture MUST NOT already be PASS — a mutation is only observable against a
            # fixture whose correct answer differs from the mutation's answer.
            v = classify(inp(p=producer(filled_lag_h=STALE_HOURS + 1)), NOW)
            if v["verdict"] != "FAIL":
                return False
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

    def record_fields():
        with open(results) as fh:
            m = json.loads(fh.read().splitlines()[-1])["metrics"]
        return (m.get("census_source") == "emitter" and m.get("past_reach") == 0
                and m.get("servable_uncapped") == 800 and m.get("queue_limit") == LIMIT
                and m.get("workable") == 900 and m.get("workable_reachable") == 900
                and m.get("venue_silent") == [] and m.get("arms", {}).get("venue_silence") == "PASS")
    check("R6 record carries census_source, past_reach, servable_uncapped, the producer's cap and "
          "both workable figures by name", record_fields)

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
# Raised 98 -> 103 by OPS-DRIFT-ALERT-GENERATORS-W1. OPS-ALARM-OWNER-DERIVATION-W1 CH1 deleted the
# two mirror-parity checks with the mirrors they guarded (the vitest pins the emitter instead) and
# added the emitter, census, venue-silence, gather() and runtime-refusal scenarios. Measured: the
# suite ran exactly 157 — raised in the SAME edit that added them.
_SELF_TEST_MIN_CHECKS = 157


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

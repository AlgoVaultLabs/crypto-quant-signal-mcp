#!/usr/bin/env python3
"""directional-labels-race-integrity.py — EDGE-LABELER-RACE-WINDOW-V2-W1 CH4.

The race-window defect, if it ever returns, shows up in exactly two places:
- a `-v2` row whose race crossed a hole (`race_gap_candles` != 0);
- a `-v1` row with no `-v2` twin that no counted class explains.
This canary watches both, on each nightly labeler run, after the run ends.

THE SEAL (ruling Q-A = A, 2026-10-14). Every row the nightly writes lies inside the B-DIR v3 FULL sealed
holdout (`created_at > T_DIAG_END`). Above T_CAP the holdout admits CARDINALITIES ONLY. So this file's SQL
names four columns of `directional_labels` — `signal_id`, `barrier_spec`, `computed_at`, `race_gap_candles` —
and no other column of any table. No disagreement rate, decided share, flip count, barrier or expiry
column is read. `tests/unit/directional-labels-race-integrity.test.ts` asserts that allow-list over
`--print-sql`, so the seal is a gate, not a sentence.

CHECKS, per labeler run (its `[detector-run]` line → its DONE line):
  (1) twin identity, in SIGNALS (ruling Q-B = B):  M − (R − v1CutUnwritable) = 0
        M = signals with a `-v1` row written in the run and no `-v2` row by its end
        R = v2Refused + v2Deferred + v2UnreachableDepth + v2UnreachableHistory (the DONE line)
      residual != 0 → FAIL. budgetSkips > 0, a missing DONE line, or a DONE line without
      `v1CutUnwritable` (a run before the counter landed) → INDETERMINATE.
      V2_HELDBACK pending/released and V2_NO_V1_TWIN are printed as cardinalities, outside the
      identity: a held-back signal writes neither family.
  (1b) spec-set completeness (rider 1): the run's `-v2` rows per τ are equal (written together) → else FAIL.
  (2) `race_gap_candles` = 0 on every new `-v2` row → else FAIL.
      LRW-Q3 live recount: on a sample of the run's new `-v1` rows, the labeler's own derivation re-run
      now (`--recount-gaps` in the app container) EQUALS the stored value → else FAIL. Equality, never a
      constant. A sampled signal whose `-v1` rows disagree among themselves is a FAIL too.
  (3) `-v2` freshness: newest `FRESHNESS_BARRIER_SPEC_V2` row ≤ V2_FRESHNESS_MAX_AGE_H old → else FAIL.
      The spec name comes from the deployed derivation (`LRW_V2_FRESHNESS_SPEC`), never retyped here.
  (4) the cardinalities it reconciled, printed every run.

VERDICT LADDER and PAGING (rider 2; the runbook contract, DETECTOR_ENVELOPE):
- FAIL outranks INDETERMINATE, which outranks PASS.
- A labeler run whose `run_outcome` is not conclusive forces INDETERMINATE.
- INDETERMINATE never pages.
- The first ARMING_REPORT_ONLY_RUNS labeler runs carrying the counter are report-only: printed and
  recorded, no page.
- After that, DIRECTIONAL_LABELS_RACE_INTEGRITY pages on PAGE_AFTER_CONSECUTIVE_FAILS consecutive FAIL
  runs, through send_telegram.sh (CRITICAL_PERSISTENT — the only severity it delivers — and its 24 h
  cooldown).
- Each run is evaluated alone, never across a preempt / catch-up pair.

OUTPUT: per-check lines, one DETECTOR_ENVELOPE line (carrying `seal` and the identity as evidence text),
one result line in canary-results.jsonl (pulled into the vault by monitoring-results-sync.sh), and the
terminal token `DIRECTIONAL_LABELS_RACE_INTEGRITY_VERDICT=PASS|FAIL|INDETERMINATE` (exit 0 / 1 / 3).

  directional-labels-race-integrity.py              the nightly run (root cron, after the labeler)
  directional-labels-race-integrity.py --self-test  hermetic; proves every verdict both ways
  directional-labels-race-integrity.py --print-sql  every SQL text it can send, as JSON (the seal test)
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# Guarded, as in every sibling: a recorder or a contract module missing on the host must degrade to a
# run that SAYS so, never abort the run at import time.
try:
    from canary_result_log import append_result as _append_result

    _RESULT_LOG_IMPORT_ERROR = ""
except Exception as _import_err:  # noqa: BLE001
    _RESULT_LOG_IMPORT_ERROR = f"{type(_import_err).__name__}: {_import_err}"

    def _append_result(*_a, **_k):  # type: ignore[misc]
        return False, f"canary_result_log unavailable ({_RESULT_LOG_IMPORT_ERROR})"

try:
    import detector_envelope as de

    _ENVELOPE_IMPORT_ERROR = ""
except Exception as _import_err:  # noqa: BLE001
    de = None  # type: ignore[assignment]
    _ENVELOPE_IMPORT_ERROR = f"{type(_import_err).__name__}: {_import_err}"

CANARY = "directional-labels-race-integrity"
DETECTOR = "directional-labels-race-integrity"
ALERT_ID = "DIRECTIONAL_LABELS_RACE_INTEGRITY"
SEVERITY_DELIVERED = "CRITICAL_PERSISTENT"
TOKEN = "DIRECTIONAL_LABELS_RACE_INTEGRITY_VERDICT"
SEAL_TEXT = "T_CAP cardinalities only"
IDENTITY_TEXT = "M − (R − v1CutUnwritable) = 0"

LOG_PATH = os.environ.get("RI_LOG", "/var/log/carry-labeler.log")
PSQL_CMD = os.environ.get(
    "RI_PSQL_CMD",
    "docker exec -i crypto-quant-signal-mcp-postgres-1 psql -U aoe_readonly -d signal_performance -qtA -v ON_ERROR_STOP=1",
)
APP_CTR = os.environ.get("RI_APP_CTR", "crypto-quant-signal-mcp-mcp-server-1")
TG = os.environ.get("RI_TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
STATE_PATH = os.environ.get("RI_STATE", "/var/lib/algovault-monitoring/directional-labels-race-integrity.state.json")

# How many of the run's new -v1 signals are recounted live. A sample, never a scan: each costs one or two
# venue pages under the batch class.
RECOUNT_SAMPLE = 12
# The -v2 freshness bound: the nightly cadence (24 h) + the longest measured run span (~3.6 h, 2026-10-14) +
# margin. One missed nightly exceeds it; one late nightly does not.
V2_FRESHNESS_MAX_AGE_H = 30
ARMING_REPORT_ONLY_RUNS = 3
PAGE_AFTER_CONSECUTIVE_FAILS = 2

# The DONE-line fields the identity and the printout need. Their names are the producer's own
# (Coverage in src/scripts/backfill-directional-labels.ts).
R_FIELDS = ("v2Refused", "v2Deferred", "v2UnreachableDepth", "v2UnreachableHistory")
PRINTED_FIELDS = ("v2HeldBack", "v2HeldBackReleased", "v2NoV1Twin", "v2Labeled", "written", "budgetSkips", "errors")
CUT_FIELD = "v1CutUnwritable"
SPEC_RE = re.compile(r"^tau[0-9.]+-floor[0-9.]+-v2$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$")

PASS, FAIL, IND = "PASS", "FAIL", "INDETERMINATE"
EXIT = {PASS: 0, FAIL: 1, IND: 3}


def log(msg):
    print(f"[race-integrity] {msg}", flush=True)


# ── the producer's record (pure) ─────────────────────────────────────────────────────────────────────


def parse_run(text):
    """PURE. The LAST labeler run in the log, as {run_id, started_at, ended_at, done, outcome} or an
    {"error": why}. Each run is read alone: its scope starts at its own `[detector-run]` line, so a
    preempted run and its catch-up are never mixed."""
    lines = text.splitlines()
    start = None
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].startswith("[detector-run] run_id=dwr-"):
            start = i
            break
    if start is None:
        return {"error": "no-labeler-run-in-log"}
    run_id = lines[start].split("run_id=", 1)[1].strip()
    started_at = run_id[len("dwr-"):]
    if not ISO_RE.match(started_at):
        return {"error": "unparseable-run-id"}
    done = ended_at = outcome = None
    for line in lines[start + 1:]:
        if line.startswith("[detector-run] run_id="):
            break  # a newer process: never mix two runs
        if line.startswith("[detector-envelope] {") and outcome is None:
            try:
                env = json.loads(line.split("[detector-envelope]", 1)[1].strip())
            except ValueError:
                return {"error": "unparseable-labeler-envelope", "run_id": run_id}
            if env.get("run_id") == run_id:
                outcome = env.get("run_outcome")
        m = re.match(r"^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)\] DONE (\{.*\})\s*$", line)
        if m and done is None:
            try:
                done = json.loads(m.group(2))
            except ValueError:
                return {"error": "unparseable-done-line", "run_id": run_id}
            ended_at = m.group(1)
    if done is None:
        return {"error": "no-done-line", "run_id": run_id, "started_at": started_at}
    return {"run_id": run_id, "started_at": started_at, "ended_at": ended_at, "done": done, "outcome": outcome or "unknown"}


# ── the four-column reads (pure builders; --print-sql emits exactly these) ───────────────────────────


def _ts(iso):
    if not ISO_RE.match(iso):
        raise ValueError(f"not an ISO-8601 UTC instant: {iso!r}")
    return f"'{iso}'"


def sql_texts(started_at, ended_at, freshness_spec):
    """PURE. Every statement this canary sends, keyed by purpose. Only `signal_id`, `barrier_spec`,
    `computed_at` and `race_gap_candles` of `directional_labels` are named."""
    s, e = _ts(started_at), _ts(ended_at)
    win = f"computed_at >= {s} AND computed_at <= {e}"
    out = {
        "m_signals": (
            "SELECT count(*) FROM (SELECT signal_id FROM directional_labels "
            f"WHERE barrier_spec LIKE '%-v1' AND {win} GROUP BY signal_id) w "
            "WHERE NOT EXISTS (SELECT 1 FROM directional_labels t WHERE t.signal_id = w.signal_id "
            f"AND t.barrier_spec LIKE '%-v2' AND t.computed_at <= {e})"
        ),
        "v1_rows": f"SELECT count(*) FROM directional_labels WHERE barrier_spec LIKE '%-v1' AND {win}",
        "v2_rows_by_spec": (
            f"SELECT barrier_spec, count(*) FROM directional_labels WHERE barrier_spec LIKE '%-v2' AND {win} "
            "GROUP BY barrier_spec ORDER BY barrier_spec"
        ),
        "v2_gap_nonzero": (
            f"SELECT count(*) FROM directional_labels WHERE barrier_spec LIKE '%-v2' AND {win} "
            "AND race_gap_candles IS DISTINCT FROM 0"
        ),
        "v1_gap_sample": (
            "SELECT signal_id, min(race_gap_candles), max(race_gap_candles) FROM directional_labels "
            f"WHERE barrier_spec LIKE '%-v1' AND {win} AND race_gap_candles IS NOT NULL "
            f"GROUP BY signal_id ORDER BY signal_id DESC LIMIT {RECOUNT_SAMPLE}"
        ),
    }
    if freshness_spec is not None:
        if not SPEC_RE.match(freshness_spec):
            raise ValueError(f"not a -v2 spec: {freshness_spec!r}")
        out["v2_freshness"] = (
            "SELECT coalesce(extract(epoch FROM max(computed_at))::bigint, 0) FROM directional_labels "
            f"WHERE barrier_spec = '{freshness_spec}'"
        )
    return out


def parse_rows(out):
    """PURE. psql -qtA output (default `|` separator) → list of field lists, blank lines dropped."""
    return [line.split("|") for line in out.splitlines() if line.strip()]


def parse_recount(out):
    """PURE. The recount module's output → (freshness_spec or None, {signal_id: gap or None})."""
    spec = None
    gaps = {}
    for line in out.splitlines():
        if line.startswith("LRW_V2_FRESHNESS_SPEC "):
            cand = line.split(" ", 1)[1].strip()
            spec = cand if SPEC_RE.match(cand) else None
        elif line.startswith("LRW_GAP_RECOUNT "):
            try:
                rec = json.loads(line.split(" ", 1)[1])
                gaps[int(rec["id"])] = rec.get("gap") if isinstance(rec.get("gap"), int) else None
            except (ValueError, KeyError, TypeError):
                continue
    return spec, gaps


# ── the decision (pure) ──────────────────────────────────────────────────────────────────────────────


def judge(run, db, recount, now_s):
    """PURE. `run` = parse_run(); `db` = {name: rows} or {"error": why}; `recount` = (spec, gaps) or
    {"error": why}. Returns {verdict, checks: {name: (verdict, detail)}, metrics}."""
    checks = {}
    metrics = {"seal": SEAL_TEXT, "identity": IDENTITY_TEXT}
    if "error" in run:
        checks["run"] = (IND, run["error"])
        return {"verdict": IND, "checks": checks, "metrics": metrics}
    done = run["done"]
    metrics.update({"run_id": run["run_id"], "run_outcome": run["outcome"]})
    for f in R_FIELDS + PRINTED_FIELDS:
        if isinstance(done.get(f), int):
            metrics[f] = done[f]
    if "error" in db:
        checks["db"] = (IND, db["error"])
        return {"verdict": IND, "checks": checks, "metrics": metrics}

    def one(name):
        rows = db.get(name) or []
        return int(rows[0][0]) if rows and rows[0] and rows[0][0].strip().lstrip("-").isdigit() else None

    m, v1_rows, gap_nz = one("m_signals"), one("v1_rows"), one("v2_gap_nonzero")
    metrics.update({"m_signals": m, "v1_rows": v1_rows, "v2_gap_nonzero": gap_nz})

    # (1) the twin identity, in signals
    missing_r = [f for f in R_FIELDS if not isinstance(done.get(f), int)]
    if missing_r:
        checks["identity"] = (IND, "done-line-lacks:" + ",".join(missing_r))
    elif not isinstance(done.get(CUT_FIELD), int):
        checks["identity"] = (IND, "v1CutUnwritable-absent (a run before the counter landed)")
    elif isinstance(done.get("budgetSkips"), int) and done["budgetSkips"] > 0:
        checks["identity"] = (IND, f"budgetSkips={done['budgetSkips']} (a skipped group counted rows it never wrote)")
    elif m is None:
        checks["identity"] = (IND, "m-unread")
    else:
        r = sum(done[f] for f in R_FIELDS)
        cut = done[CUT_FIELD]
        residual = m - (r - cut)
        metrics.update({"r_signals": r, CUT_FIELD: cut, "residual": residual})
        checks["identity"] = (PASS if residual == 0 else FAIL, f"M={m} R={r} cut={cut} residual={residual}")

    # (1b) spec-set completeness: the run's -v2 rows per τ are equal
    by_spec = {row[0]: int(row[1]) for row in (db.get("v2_rows_by_spec") or []) if len(row) == 2 and row[1].isdigit()}
    metrics["v2_rows_by_spec"] = ",".join(f"{k}={v}" for k, v in sorted(by_spec.items())) or "none"
    if len(set(by_spec.values())) > 1:
        checks["spec_set"] = (FAIL, f"unequal per-τ -v2 rows: {metrics['v2_rows_by_spec']}")
    elif by_spec and len(by_spec) != 3:
        checks["spec_set"] = (FAIL, f"{len(by_spec)} of 3 -v2 specs written: {metrics['v2_rows_by_spec']}")
    else:
        checks["spec_set"] = (PASS, f"per-τ -v2 rows equal: {metrics['v2_rows_by_spec']}")

    # (2a) no new -v2 row raced across a hole
    if gap_nz is None:
        checks["v2_gap_zero"] = (IND, "unread")
    else:
        checks["v2_gap_zero"] = (PASS if gap_nz == 0 else FAIL, f"new -v2 rows with race_gap_candles != 0: {gap_nz}")

    # (2b) LRW-Q3 live recount equality on the sample
    sample = []
    for row in db.get("v1_gap_sample") or []:
        if len(row) == 3 and all(x.strip().lstrip("-").isdigit() for x in row):
            sample.append((int(row[0]), int(row[1]), int(row[2])))
    metrics["recount_sample"] = len(sample)
    spec = None
    if "error" in recount:
        checks["recount"] = (IND, recount["error"])
    else:
        spec, gaps = recount
        split = [sid for sid, lo, hi in sample if lo != hi]
        compared = [(sid, lo, gaps.get(sid)) for sid, lo, hi in sample if lo == hi and gaps.get(sid) is not None]
        unequal = [f"{sid}:{stored}->{live}" for sid, stored, live in compared if stored != live]
        metrics.update({"recount_compared": len(compared), "recount_unequal": len(unequal), "gap_spec_split": len(split)})
        if split:
            checks["recount"] = (FAIL, f"-v1 rows of one signal disagree on race_gap_candles: {split[:5]}")
        elif unequal:
            checks["recount"] = (FAIL, f"live recount != stored: {unequal[:5]}")
        elif not sample:
            checks["recount"] = (PASS, "the run wrote no -v1 row with a gap value (nothing to recount)")
        elif not compared:
            checks["recount"] = (IND, f"no sampled signal recounted ({len(sample)} sampled)")
        else:
            checks["recount"] = (PASS, f"{len(compared)} of {len(sample)} sampled recounted, all equal")

    # (3) -v2 freshness, on the deployed derivation's own series name
    newest = one("v2_freshness")
    if spec is None or newest is None:
        checks["v2_freshness"] = (IND, "series name or newest row unread")
    else:
        age_h = round((now_s - newest) / 3600.0, 2) if newest > 0 else None
        metrics.update({"v2_freshness_spec": spec, "v2_newest_age_h": age_h})
        if age_h is None:
            checks["v2_freshness"] = (FAIL, f"no {spec} row at all")
        else:
            ok = age_h <= V2_FRESHNESS_MAX_AGE_H
            checks["v2_freshness"] = (PASS if ok else FAIL, f"newest {spec} row {age_h} h old (max {V2_FRESHNESS_MAX_AGE_H})")

    verdicts = [v for v, _ in checks.values()]
    verdict = FAIL if FAIL in verdicts else IND if IND in verdicts else PASS
    # DETECTOR_ENVELOPE forcing rule: a run that did not finish its measurement earns no conclusion
    if run["outcome"] not in ("complete", "venue-budget", "global-budget") and verdict != IND:
        checks["run_outcome"] = (IND, f"labeler run_outcome={run['outcome']} is not conclusive")
        verdict = IND
    return {"verdict": verdict, "checks": checks, "metrics": metrics}


def paging(verdict, run_id, counter_present, state):
    """PURE. (page: bool, report_only: bool, new_state). Arming counts distinct labeler runs whose DONE line
    carried the counter; consecutive FAILs count distinct runs; anything but FAIL resets the streak."""
    st = {"counter_runs": list(state.get("counter_runs", [])), "fail_streak": list(state.get("fail_streak", []))}
    if counter_present and run_id and run_id not in st["counter_runs"]:
        st["counter_runs"].append(run_id)
    st["counter_runs"] = st["counter_runs"][-50:]
    if verdict == FAIL and run_id:
        if run_id not in st["fail_streak"]:
            st["fail_streak"].append(run_id)
    elif run_id not in st["fail_streak"]:
        st["fail_streak"] = []
    st["fail_streak"] = st["fail_streak"][-10:]
    report_only = len(st["counter_runs"]) <= ARMING_REPORT_ONLY_RUNS
    page = verdict == FAIL and not report_only and len(st["fail_streak"]) >= PAGE_AFTER_CONSECUTIVE_FAILS
    return page, report_only, st


def envelope(result, run, produced_at):
    """The canary's own DETECTOR_ENVELOPE: evidence = scalars + the seal and identity as short text."""
    started = run.get("started_at") or produced_at
    ended = run.get("ended_at") or produced_at
    ev = {k: v for k, v in result["metrics"].items() if isinstance(v, (int, float, str)) and k not in ("run_id", "run_outcome")}
    for name, (v, _) in result["checks"].items():
        ev[f"check_{name}"] = v
    return {
        "schema_version": 1,
        "detector": DETECTOR,
        "verdict": result["verdict"],
        "run_id": run.get("run_id") or "none",
        "run_started_at": started,
        "run_outcome": run.get("outcome") if run.get("outcome") in ("complete", "venue-budget", "global-budget",
                                                                     "venue-error", "venue-circuit-break", "stopped") else "unknown",
        "produced_at": produced_at,
        "observation_window": {"from": started, "to": ended},
        "evidence": ev,
    }


# ── the world (thin seams; the self-test replaces exactly these) ─────────────────────────────────────


def read_db(texts):
    rows = {}
    for name, sql in texts.items():
        try:
            out = subprocess.run(PSQL_CMD.split(), input=sql + ";\n", capture_output=True, text=True, timeout=600)
        except Exception as e:  # noqa: BLE001
            return {"error": f"psql {name}: {type(e).__name__}"}
        if out.returncode != 0:
            return {"error": f"psql {name} rc={out.returncode}: {out.stderr.strip()[:120]}"}
        rows[name] = parse_rows(out.stdout)
    return rows


def run_recount(ids):
    if not ids:
        # the series name prints before any lookup; an id no signal can have prints no recount line
        ids = [2147483647]
    cmd = ["docker", "exec", APP_CTR, "node", "dist/scripts/backfill-directional-labels.js",
           "--recount-gaps", ",".join(str(i) for i in ids)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    except Exception as e:  # noqa: BLE001
        return {"error": f"recount: {type(e).__name__}"}
    spec, gaps = parse_recount(out.stdout)
    if spec is None:
        return {"error": f"recount printed no -v2 series (rc={out.returncode})"}
    return spec, gaps


def labeler_alive():
    """A labeler process other than this canary's own recount. pgrep's pattern carries a bracket class so
    the shell running it can never match itself."""
    try:
        out = subprocess.run(["pgrep", "-af", "[b]ackfill-directional-labels"], capture_output=True, text=True, timeout=30)
        return any(l.strip() and "--recount-gaps" not in l for l in out.stdout.splitlines())
    except Exception:  # noqa: BLE001
        return False


def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as fh:
            st = json.load(fh)
            return st if isinstance(st, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def save_state(st):
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(st, fh)
        os.replace(tmp, STATE_PATH)
        return True
    except Exception as e:  # noqa: BLE001
        log(f"STATE_WRITE_FAILED {type(e).__name__}: {e}")
        return False


def main():
    now = datetime.now(timezone.utc)
    produced_at = now.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    try:
        with open(LOG_PATH, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        run = parse_run(text)
    except OSError as e:
        run = {"error": f"log-unreadable: {type(e).__name__}"}
    if "error" in run and run["error"] == "no-done-line" and labeler_alive():
        run["error"] = "labeler-still-running"
    db, recount = {"error": "not-read"}, {"error": "not-read"}
    if "error" not in run:
        sample_ids = []
        db = read_db(sql_texts(run["started_at"], run["ended_at"], None))
        if "error" not in db:
            sample_ids = [int(r[0]) for r in db.get("v1_gap_sample", []) if r and r[0].isdigit()]
        recount = run_recount(sample_ids)
        if "error" not in db and "error" not in recount:
            extra = read_db({"v2_freshness": sql_texts(run["started_at"], run["ended_at"], recount[0])["v2_freshness"]})
            db = {**db, **extra} if "error" not in extra else {"error": extra["error"]}
    result = judge(run, db, recount, int(now.timestamp()))
    for name, (v, detail) in result["checks"].items():
        log(f"CHECK {name} {v} — {detail}")
    log("COUNTS " + " ".join(f"{k}={v}" for k, v in result["metrics"].items() if k not in ("seal", "identity")))

    counter_present = "error" not in run and isinstance(run["done"].get(CUT_FIELD), int)
    inert = os.environ.get("ALGOVAULT_TG_TEST_INERT") == "1"
    state = load_state()
    page, report_only, new_state = paging(result["verdict"], run.get("run_id"), counter_present, state)
    if not inert:
        save_state(new_state)
    log(f"PAGING report_only={report_only} counter_runs={len(new_state['counter_runs'])} "
        f"fail_streak={len(new_state['fail_streak'])} page={page}{' (TEST_INERT: state not written)' if inert else ''}")

    env = envelope(result, run, produced_at)
    if de is None:
        log(f"ENVELOPE_UNAVAILABLE {_ENVELOPE_IMPORT_ERROR}")
    else:
        try:
            errs = de.validate(env, de.load_schema())
        except Exception as e:  # noqa: BLE001
            errs = [f"schema unreadable: {type(e).__name__}"]
        if errs:
            log(f"ENVELOPE_REFUSED {errs[:3]}")
        else:
            print(f"[detector-envelope] {json.dumps(env, separators=(',', ':'))}", flush=True)
    if page:
        body = "\n".join([
            f"🛑 {ALERT_ID}",
            de.render_body(env, de.load_schema()) if de is not None else json.dumps(env["evidence"]),
            "Action: dispatch OPS-LABELER-RACE-INTEGRITY-W{NEXT} via Cowork → Claude Code",
            f"Source log: {LOG_PATH}",
        ])
        try:
            subprocess.run([TG, ALERT_ID, SEVERITY_DELIVERED, "-"], input=body, text=True, timeout=60)
            log(f"PAGED {ALERT_ID} run={run.get('run_id')}")
        except Exception as e:  # noqa: BLE001
            log(f"PAGE_FAIL_OPEN {type(e).__name__}: {e}")
    metrics = dict(result["metrics"])
    metrics.update({f"check_{k}": v for k, (v, _) in result["checks"].items()})
    metrics.update({"report_only": report_only, "paged": page})
    ok, detail = _append_result(CANARY, result["verdict"], EXIT[result["verdict"]], metrics)
    log(f"RESULT_LOG {'written' if ok else 'NOT written'} {detail}")
    print(f"{TOKEN}={result['verdict']}", flush=True)
    return EXIT[result["verdict"]]


# ── the self-test (hermetic; every verdict both ways; the bypassed artifacts asserted directly) ──────


def self_test():
    passed = failed = 0

    def ck(name, cond):
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"SELF-TEST: ok {name}")
        else:
            failed += 1
            print(f"SELF-TEST: FAIL {name}")

    def safe(fn):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001 — an assertion that raises is not an assertion
            return f"RAISED {type(e).__name__}: {e}"

    S, E = "2026-10-15T02:35:59.286Z", "2026-10-15T06:11:00.705Z"
    done = {"v2Refused": 114, "v2Deferred": 0, "v2UnreachableDepth": 1, "v2UnreachableHistory": 1339,
            "v1CutUnwritable": 34, "v2HeldBack": 0, "v2HeldBackReleased": 6, "v2NoV1Twin": 636,
            "v2Labeled": 21483, "written": 47156, "budgetSkips": 0, "errors": 63}
    env_line = ('[detector-envelope] {"schema_version":1,"detector":"directional-label-capacity","verdict":"PASS",'
                f'"run_id":"dwr-{S}","run_outcome":"global-budget"}}')

    def log_text(d=done, outcome_line=env_line, with_done=True, extra_run=False):
        lines = ["[nightly-carry-labeler] STEP directional-labels START", f"[detector-run] run_id=dwr-{S}",
                 "[x] some progress line", outcome_line]
        if with_done:
            lines.append(f"[{E}] DONE {json.dumps(d)}")
        if extra_run:
            lines.append("[detector-run] run_id=dwr-2026-10-15T07:00:00.000Z")
        return "\n".join(lines) + "\n"

    good_db = {"m_signals": [["1420"]], "v1_rows": [["25673"]], "v2_gap_nonzero": [["0"]],
               "v2_rows_by_spec": [["tau0.5-floor0.30-v2", "7161"], ["tau1.0-floor0.30-v2", "7161"], ["tau2.0-floor0.30-v2", "7161"]],
               "v1_gap_sample": [["900003", "0", "0"], ["900002", "2", "2"], ["900001", "0", "0"]],
               "v2_freshness": [["1792000000"]]}
    good_recount = ("tau1.0-floor0.30-v2", {900003: 0, 900002: 2, 900001: 0})
    now_s = 1792000000 + 3600
    # identity on the fixture: M = 1420, R = 114 + 0 + 1 + 1339 = 1454, cut = 34 → residual 0
    run = parse_run(log_text())
    ck("parse_run reads the last run alone", run.get("run_id") == f"dwr-{S}" and run.get("ended_at") == E and run.get("outcome") == "global-budget")
    j = safe(lambda: judge(run, good_db, good_recount, now_s))
    ck("all clean → PASS", isinstance(j, dict) and j["verdict"] == PASS)
    ck("identity residual printed 0", isinstance(j, dict) and j["metrics"].get("residual") == 0 and j["metrics"].get("r_signals") == 1454)
    ck("seal + identity text carried", isinstance(j, dict) and j["metrics"].get("seal") == SEAL_TEXT and j["metrics"].get("identity") == IDENTITY_TEXT)

    bad = dict(good_db, m_signals=[["1421"]])
    ck("residual != 0 → FAIL", safe(lambda: judge(run, bad, good_recount, now_s)["checks"]["identity"][0]) == FAIL)
    bad = dict(good_db, m_signals=[["1419"]])
    ck("residual < 0 → FAIL too (two-sided)", safe(lambda: judge(run, bad, good_recount, now_s)["checks"]["identity"][0]) == FAIL)
    d2 = dict(done); d2.pop("v1CutUnwritable")
    ck("counter absent (pre-landing run) → INDETERMINATE", safe(lambda: judge(parse_run(log_text(d2)), good_db, good_recount, now_s)["checks"]["identity"][0]) == IND)
    d3 = dict(done, budgetSkips=2)
    ck("budgetSkips > 0 → INDETERMINATE", safe(lambda: judge(parse_run(log_text(d3)), good_db, good_recount, now_s)["checks"]["identity"][0]) == IND)
    ck("no DONE line → INDETERMINATE", safe(lambda: judge(parse_run(log_text(with_done=False)), good_db, good_recount, now_s)["verdict"]) == IND)
    ck("a newer run without DONE is read alone (preempt/catch-up never mixed)",
       safe(lambda: parse_run(log_text(extra_run=True)).get("error")) == "no-done-line")
    stopped = env_line.replace('"global-budget"', '"stopped"')
    ck("non-conclusive labeler outcome forces INDETERMINATE",
       safe(lambda: judge(parse_run(log_text(outcome_line=stopped)), good_db, good_recount, now_s)["verdict"]) == IND)
    bad = dict(good_db, v2_rows_by_spec=[["tau0.5-floor0.30-v2", "7161"], ["tau1.0-floor0.30-v2", "7160"], ["tau2.0-floor0.30-v2", "7161"]])
    ck("unequal per-τ -v2 rows → FAIL", safe(lambda: judge(run, bad, good_recount, now_s)["checks"]["spec_set"][0]) == FAIL)
    bad = dict(good_db, v2_rows_by_spec=[["tau0.5-floor0.30-v2", "7161"], ["tau1.0-floor0.30-v2", "7161"]])
    ck("a missing -v2 spec → FAIL", safe(lambda: judge(run, bad, good_recount, now_s)["checks"]["spec_set"][0]) == FAIL)
    bad = dict(good_db, v2_gap_nonzero=[["1"]])
    ck("a new -v2 row with a gap → FAIL", safe(lambda: judge(run, bad, good_recount, now_s)["checks"]["v2_gap_zero"][0]) == FAIL)
    ck("recount != stored → FAIL", safe(lambda: judge(run, good_db, ("tau1.0-floor0.30-v2", {900003: 0, 900002: 1, 900001: 0}), now_s)["checks"]["recount"][0]) == FAIL)
    bad = dict(good_db, v1_gap_sample=[["900003", "0", "1"]])
    ck("one signal's -v1 rows disagreeing on the gap → FAIL", safe(lambda: judge(run, bad, good_recount, now_s)["checks"]["recount"][0]) == FAIL)
    ck("no sampled signal recounted → INDETERMINATE", safe(lambda: judge(run, good_db, ("tau1.0-floor0.30-v2", {}), now_s)["checks"]["recount"][0]) == IND)
    ck("recount unavailable → INDETERMINATE", safe(lambda: judge(run, good_db, {"error": "recount: TimeoutExpired"}, now_s)["checks"]["recount"][0]) == IND)
    ck("stale -v2 → FAIL", safe(lambda: judge(run, good_db, good_recount, 1792000000 + 31 * 3600)["checks"]["v2_freshness"][0]) == FAIL)
    ck("db unreadable → INDETERMINATE", safe(lambda: judge(run, {"error": "psql rc=2"}, good_recount, now_s)["verdict"]) == IND)
    ck("FAIL outranks INDETERMINATE", safe(lambda: judge(run, dict(good_db, v2_gap_nonzero=[["3"]]), {"error": "x"}, now_s)["verdict"]) == FAIL)

    # the bypassed artifacts: the SQL builders (the seal allow-list) and the output parsers
    texts = safe(lambda: sql_texts(S, E, "tau1.0-floor0.30-v2"))
    allowed = {"signal_id", "barrier_spec", "computed_at", "race_gap_candles"}
    forbidden = ("label", "ret_at_expiry_pct", "barrier_pct", "ambiguous_candle", "low_vol_history", "t_hit_candles", "mfe_return_pct", "mae_return_pct")
    named = set()
    if isinstance(texts, dict):
        for t in texts.values():
            named |= set(re.findall(r"\b(signal_id|barrier_spec|computed_at|race_gap_candles|label|ret_at_expiry_pct|barrier_pct|ambiguous_candle|low_vol_history|t_hit_candles|mfe_return_pct|mae_return_pct)\b", t))
    ck("the SQL names only the four allowed columns", isinstance(texts, dict) and named == allowed)
    ck("no forbidden column in any statement", isinstance(texts, dict) and not any(re.search(rf"\b{f}\b", t) for t in texts.values() for f in forbidden))
    ck("a non-ISO window bound is refused", str(safe(lambda: sql_texts("2026-10-15 02:35", E, None))).startswith("RAISED ValueError"))
    ck("a non -v2 freshness spec is refused", str(safe(lambda: sql_texts(S, E, "tau1.0-floor0.30-v1"))).startswith("RAISED ValueError"))
    ck("psql rows parse (| separated)", parse_rows("1|2|3\n\n4|5|6\n") == [["1", "2", "3"], ["4", "5", "6"]])
    ck("recount output parses",
       parse_recount('LRW_V2_FRESHNESS_SPEC tau1.0-floor0.30-v2\nLRW_GAP_RECOUNT {"id":5,"gap":2}\nLRW_GAP_RECOUNT {"id":6,"gap":null,"error":"X"}\nnoise\n')
       == ("tau1.0-floor0.30-v2", {5: 2, 6: None}))

    # paging: report-only arming, consecutive FAILs over distinct runs, INDETERMINATE never pages
    st = {}
    pages = []
    for i, v in enumerate([FAIL, FAIL, FAIL, FAIL, FAIL]):
        p, ro, st = paging(v, f"r{i}", True, st)
        pages.append((p, ro))
    ck("first 3 counter runs are report-only, then 2 consecutive FAILs page", pages == [(False, True), (False, True), (False, True), (True, False), (True, False)])
    p, ro, _ = paging(IND, "r4", True, st)
    ck("INDETERMINATE never pages, even re-evaluating a run already inside an armed FAIL streak", p is False)
    p, ro, st2 = paging(IND, "r9", True, st)
    ck("INDETERMINATE never pages and breaks the streak", p is False and st2["fail_streak"] == [])
    p, ro, st3 = paging(FAIL, "r10", True, st2)
    ck("one FAIL after a break does not page", p is False)
    p, ro, st4 = paging(FAIL, "r10", True, st3)
    ck("the same run re-evaluated does not extend the streak", p is False and st4["fail_streak"] == ["r10"])
    p, ro, st5 = paging(FAIL, "x1", False, {})
    ck("a run without the counter never arms", ro is True and st5["counter_runs"] == [])

    # the envelope is accepted by the contract (when the consumer module is installed beside us)
    if de is not None:
        j = judge(run, good_db, good_recount, now_s)
        env = envelope(j, run, "2026-10-15T07:23:00.000Z")
        errs = safe(lambda: de.validate(env, de.load_schema()))
        ck("own envelope conforms to DETECTOR_ENVELOPE", errs == [])
        ck("envelope carries seal + identity as evidence text", env["evidence"].get("seal") == SEAL_TEXT and env["evidence"].get("identity") == IDENTITY_TEXT)
    else:
        print(f"SELF-TEST: note detector_envelope not importable here ({_ENVELOPE_IMPORT_ERROR}); envelope checks skipped")

    floor = 35 if de is not None else 33
    if failed == 0 and passed >= floor:
        print(f"RACE_INTEGRITY_SELFTEST: PASS ({passed} checks)")
        return 0
    print(f"RACE_INTEGRITY_SELFTEST: FAIL ({failed} of {passed + failed})")
    return 1


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    if "--print-sql" in sys.argv:
        print(json.dumps(sql_texts("2026-01-01T00:00:00.000Z", "2026-01-01T04:00:00.000Z", "tau1.0-floor0.30-v2"), indent=1))
        sys.exit(0)
    sys.exit(main())

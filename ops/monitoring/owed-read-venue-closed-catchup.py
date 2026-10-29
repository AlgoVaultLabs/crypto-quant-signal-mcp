#!/usr/bin/env python3
"""owed-read-venue-closed-catchup.py — OPS-VENUE-MARKET-CLOSED-W1 CH2. Did the closed-market fix land?

Owner wave: OPS-VENUE-MARKET-CLOSED-W1. Its CH1 (deployed at DEPLOY_AT) refuses a market its venue's status declares
closed, at the `getAdapter` seam with zero requests. It types BingX's in-band pause (109415) and ban (109429), and
moves the backfill cooldown from 24 h to 18 h, so a closure's retry walks the clock instead of locking onto the
closed hours. The walk lands in sessions days after the deploy. This read answers it from the producer's own
record, once, on ONE database snapshot, and prints

    OWED_READ_METRICS=<json object, <= 4 KiB>
    OWED_READ_VERDICT=PASS|FAIL|INDETERMINATE

── LEGS (pre-registered in the wave's spec, CH2; this file implements them and never retunes them) ──
  A  catch-up. The 162 rows frozen at R0.2 (BINGX NC*, `outcome_price IS NULL`, matured, in reach, on coins
     seeded in the prior 7 d). FAIL iff a row still IN REACH at `now` (the producer's own past-reach clause, from
     the census emitter) has `outcome_filled_at IS NULL`. A row filled at or before DEPLOY_AT is reported apart,
     because it filled before the fix existed (CORRECTION 1 of the wave: R0 ran at 16:01Z, inside the US session).
     Rows that crossed reach are reported. An empty in-reach cohort, or a frozen id the table no longer holds,
     is INDETERMINATE.
  B  no closure page. FAIL iff one `BINGX|NC*` key is in arm 3e's paged set (`coin_silent`, from the
     outcome-backfill canary's records in canary-results.jsonl) on two different UTC dates inside
     [DEPLOY_AT + 72 h, NOT_BEFORE]; otherwise the count is reported. INDETERMINATE when the records do not cover
     the window or a record's key list was capped (absence would be unprovable).
  C  no ban. FAIL iff `rate_limit_events` holds a BingX ban row (109429 / 418 / 429) after DEPLOY_AT, reported
     by caller. INDETERMINATE when the instrument wrote no BingX row at all since DEPLOY_AT (R0.3 measured it
     live: 208 rows in 7 d).

  PASS iff A and B and C. FAIL iff any leg failed on a complete measurement. Else INDETERMINATE.

Every database statement runs in ONE `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction as
`aoe_readonly`. Label-blind: ids, timestamps, counts and IS NULL predicates only.

    owed-read-venue-closed-catchup.py --run --now EPOCH [--sandbox] < anchors.json   (the runner)
    owed-read-venue-closed-catchup.py --self-test
"""
from __future__ import annotations

import argparse
import calendar
import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

CANARY_FILE = os.path.join(HERE, "outcome-backfill-freshness.py")
CANARY_NAME = "outcome_backfill_freshness"

# ── the pre-registration (spec CH2; vault audits/OPS-VENUE-MARKET-CLOSED-W1-evidence.md R0.2 / R0.3) ──
WAVE = "OPS-VENUE-MARKET-CLOSED-W1"
DEPLOY_AT = 1793292752                 # 2026-10-29T16:52:32Z, CH1's app container start on signal-1
R0_SNAPSHOT_AT = 1793289686            # 2026-10-29T16:01:26Z, the R0.2 snapshot (box clock)
COHORT_IDS = [
    592763, 657323, 668457, 668623, 668625, 707696, 717841, 732728, 732775, 732780, 732781, 811851,
    827425, 827622, 829064, 829065, 829067, 829070, 829071, 829072, 829073, 829083, 843821, 866987,
    867862, 867928, 903374, 907786, 915920, 932990, 934982, 935396, 935397, 935404, 935408, 935416,
    935433, 935501, 935504, 935513, 954073, 972063, 972073, 972402, 972420, 972554, 972556, 972569,
    972573, 972580, 996107, 996117, 1004430, 1005331, 1005335, 1050547, 1050580, 1059517, 1059574,
    1072699, 1075622, 1075626, 1075630, 1075636, 1075641, 1083367, 1084359, 1084373, 1084496, 1085174,
    1085182, 1085185, 1085576, 1085580, 1085584, 1086107, 1086108, 1086110, 1086112, 1133160, 1135946,
    1136175, 1136177, 1136178, 1136183, 1136185, 1136233, 1136235, 1136245, 1136249, 1141366, 1151100,
    1151104, 1151571, 1151573, 1151575, 1151642, 1151644, 1164084, 1164086, 1164088, 1164090, 1164094,
    1164100, 1164102, 1164104, 1164105, 1164109, 1164112, 1164114, 1164116, 1164118, 1172134, 1172519,
    1173428, 1173429, 1173430, 1173431, 1173433, 1173434, 1173435, 1174202, 1174204, 1174205, 1174206,
    1174213, 1174216, 1174219, 1196053, 1196582, 1199764, 1199777, 1200007, 1202268, 1203049, 1204167,
    1204609, 1209924, 1209930, 1209933, 1209935, 1209936, 1209938, 1210026, 1210028, 1210031, 1210038,
    1210043, 1210044, 1210045, 1210046, 1210049, 1210053, 1219766, 1224902, 1224903, 1224904, 1224905,
    1224910, 1224912, 1224913, 1224917,
]
COHORT_N = 162
NOT_BEFORE = DEPLOY_AT + 6 * 86400     # >= 8 walk retries of 18 h, a weekend included; no session arithmetic
LEG_B_WINDOW = [DEPLOY_AT + 72 * 3600, NOT_BEFORE]
BAN_CODES = ["109429", "418", "429"]
R0_3_INSTRUMENT_LIVE = True            # R0.3: 208 BingX rows in the 7 d before R0 (all kind='wait')
COVERAGE_SLACK_S = 2 * 3600            # the canary runs hourly (:13); two missed ticks still cover an edge
ANCHORS = {"deploy_at": DEPLOY_AT, "r0_snapshot_at": R0_SNAPSHOT_AT, "cohort_ids": COHORT_IDS,
           "leg_b_window": LEG_B_WINDOW, "ban_codes": BAN_CODES}
SANDBOX_KEY = "_sandbox_overrides"
SANDBOX_OVERRIDABLE = ("leg_b_window",)  # the forced-FAIL proof on live records (pre-fix pages), nothing else

PSQL_CMD = ("docker exec -i crypto-quant-signal-mcp-postgres-1 psql -X -U aoe_readonly -d signal_performance "
            "-q -tA -F | -v ON_ERROR_STOP=1")
PSQL_TIMEOUT_S = 240
STATEMENT_TIMEOUT = "60s"

VERDICTS = ("PASS", "FAIL", "INDETERMINATE")
EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
METRICS_MAX_BYTES = 4096
SAMPLE_MAX = 8
SECTIONS = ("cohort", "bans", "instrument")
_KEY_RE = re.compile(r"^BINGX\|NC[A-Z0-9]+$")


def load_canary():
    """The outcome-backfill canary as a module: its emitter (the producer's past-reach clause), psql identity and
    label-blind token list are the ONE derivation this read re-uses, never re-codes."""
    spec = importlib.util.spec_from_file_location("outcome_backfill_freshness", CANARY_FILE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def psql_identity(cmd):
    """(container, role, database) of a `docker exec … psql -U … -d …` command, or None."""
    t = shlex.split(cmd) if isinstance(cmd, str) else list(cmd)
    try:
        i = t.index("exec")
        j = i + 1
        while j < len(t) and t[j].startswith("-"):
            j += 1
        return t[j], t[t.index("-U") + 1], t[t.index("-d") + 1]
    except (ValueError, IndexError):
        return None


def utc_epoch(iso):
    """`2026-10-29T16:13:02Z` / `…+00:00` / with fraction -> epoch s, else None."""
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|\+00:00)$", str(iso or ""))
    if not m:
        return None
    return calendar.timegm(tuple(int(x) for x in m.groups()[:6]) + (0, 0, 0))


def utc_date(epoch):
    return time.strftime("%Y-%m-%d", time.gmtime(epoch))


# ── the anchors the runner hands over ────────────────────────────────────────────────────────

def resolve_anchors(anchors, sandbox):
    """-> (effective constants dict, None) or (None, reason)."""
    if not isinstance(anchors, dict):
        return None, "anchors are not a JSON object"
    overrides = anchors.get(SANDBOX_KEY)
    declared = {k: v for k, v in anchors.items() if k != SANDBOX_KEY}
    if declared != ANCHORS:
        diff = sorted(k for k in set(declared) | set(ANCHORS) if declared.get(k) != ANCHORS.get(k))
        return None, "the registry's anchors differ from this read's pre-registration on %s" % ",".join(diff)
    eff = json.loads(json.dumps(ANCHORS))
    if overrides is not None:
        if not sandbox:
            return None, "a sandbox override arrived without --sandbox — refused"
        if not isinstance(overrides, dict):
            return None, "sandbox overrides are not an object"
        bad = sorted(k for k in overrides if k not in SANDBOX_OVERRIDABLE)
        if bad:
            return None, "sandbox override key(s) %s are not overridable" % ",".join(bad)
        w = overrides.get("leg_b_window")
        if not (isinstance(w, list) and len(w) == 2 and all(type(x) is int for x in w) and w[0] < w[1]):
            return None, "sandbox override leg_b_window=%r is not [start, end] epoch ints" % (w,)
        eff["leg_b_window"] = w
    return eff, None


# ── the one-snapshot bundle ──────────────────────────────────────────────────────────────────

def clause_problems(canary, clause):
    """Why the emitted past-reach clause cannot be interpolated, as data."""
    if not isinstance(clause, str) or not clause.strip().startswith("("):
        return ["the emitter sent no parenthesised past_reach_clause"]
    probs = []
    if ";" in clause:
        probs.append("past_reach_clause carries a statement separator")
    hit = [t for t in canary.OUTCOME_VALUE_TOKENS if t in clause.lower()]
    if hit:
        probs.append("past_reach_clause names outcome value column(s) %s" % ",".join(hit))
    return probs


def build_bundle(clause, deploy_at=None):
    """psql stdin: ONE read-only repeatable-read transaction; each result set behind a MARK so a short read is
    visible. `clause` is the producer's own past-reach predicate over `signals`."""
    d = int(DEPLOY_AT if deploy_at is None else deploy_at)
    ids = ",".join(str(int(i)) for i in COHORT_IDS)
    codes = ",".join("'%s'" % c for c in BAN_CODES)
    p = ["\\set ON_ERROR_STOP on",
         "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
         "SET LOCAL statement_timeout = '%s';" % STATEMENT_TIMEOUT,
         "SELECT 'MARK|ro|' || current_setting('transaction_read_only');",
         "SELECT 'MARK|sec|cohort';",
         "SELECT id, COALESCE(outcome_filled_at::text, ''), CASE WHEN %s THEN 1 ELSE 0 END FROM signals "
         "WHERE id IN (%s) ORDER BY id;" % (clause.strip(), ids),
         "SELECT 'MARK|sec|bans';",
         "SELECT http_or_body_code, caller, COUNT(*) FROM rate_limit_events WHERE venue = 'BingX' AND kind = 'throw' "
         "AND http_or_body_code IN (%s) AND ts > to_timestamp(%d) GROUP BY 1, 2 ORDER BY 1, 2;" % (codes, d),
         "SELECT 'MARK|sec|instrument';",
         "SELECT 'n', COUNT(*) FROM rate_limit_events WHERE venue = 'BingX' AND ts > to_timestamp(%d);" % d,
         "SELECT 'MARK|end';",
         "COMMIT;"]
    return "\n".join(p) + "\n"


def parse_bundle(stdout):
    """-> {"ro": str|None, "sec": {name: [rows]}, "end": bool}."""
    out = {"ro": None, "sec": {}, "end": False}
    cur = None
    for ln in (stdout or "").splitlines():
        s = ln.strip()
        if s.startswith("MARK|"):
            f = s.split("|")
            if f[1] == "ro" and len(f) == 3:
                out["ro"], cur = f[2], None
            elif f[1] == "sec" and len(f) == 3:
                cur = f[2]
                out["sec"][cur] = []
            elif f[1] == "end":
                out["end"], cur = True, None
            continue
        if cur is not None and "|" in s:
            out["sec"][cur].append([x.strip() for x in s.split("|")])
    return out


def snapshot_problems(b):
    """Why the snapshot proves nothing, as data. Empty list = usable."""
    probs = []
    if not b["end"]:
        probs.append("the bundle did not reach MARK|end — a short read")
    if b["ro"] != "on":
        probs.append("transaction_read_only=%r, expected 'on'" % b["ro"])
    missing = [n for n in SECTIONS if n not in b["sec"]]
    if missing:
        probs.append("result set(s) missing: %s" % ",".join(missing))
    return probs


# ── the legs (pure) ──────────────────────────────────────────────────────────────────────────

def leg_a(rows, deploy_at):
    """Rows `[id, outcome_filled_at|'', past_reach 0|1]` of the frozen cohort."""
    by_id = {}
    for r in rows:
        if len(r) != 3 or not r[0].isdigit() or r[2] not in ("0", "1") or not (r[1] == "" or r[1].isdigit()):
            return {"verdict": "INDETERMINATE", "reason": "a cohort row outside the contract: %r" % (r,)}
        by_id[int(r[0])] = (None if r[1] == "" else int(r[1]), r[2] == "1")
    missing = [i for i in COHORT_IDS if i not in by_id]
    extra = sorted(i for i in by_id if i not in set(COHORT_IDS))
    if extra:
        return {"verdict": "INDETERMINATE", "reason": "rows outside the frozen cohort: %s" % extra[:SAMPLE_MAX]}
    filled_before, crossed_reach, filled_after, unfilled = [], [], [], []
    for i in COHORT_IDS:
        if i not in by_id:
            continue
        filled_at, past = by_id[i]
        if filled_at is not None and filled_at <= deploy_at:
            filled_before.append(i)
        elif past:
            crossed_reach.append(i)
        elif filled_at is None:
            unfilled.append(i)
        else:
            filled_after.append(i)
    in_reach = len(filled_after) + len(unfilled)
    leg = {"cohort_n": len(COHORT_IDS), "found": len(by_id), "missing": len(missing),
           "filled_before_deploy": len(filled_before), "crossed_reach": len(crossed_reach),
           "in_reach": in_reach, "filled_after_deploy": len(filled_after), "unfilled_in_reach": len(unfilled),
           "unfilled_sample": unfilled[:SAMPLE_MAX]}
    if unfilled:
        leg["verdict"] = "FAIL"
        leg["reason"] = "%d in-reach frozen row(s) still unfilled" % len(unfilled)
    elif missing:
        leg["verdict"] = "INDETERMINATE"
        leg["reason"] = "%d frozen id(s) absent from signals: %s" % (len(missing), missing[:SAMPLE_MAX])
    elif in_reach == 0:
        leg["verdict"] = "INDETERMINATE"
        leg["reason"] = "no frozen row is still in reach and unfilled-before-deploy — an empty cohort proves nothing"
    else:
        leg["verdict"] = "PASS"
    return leg


def read_records(path):
    """-> (records of the outcome-backfill canary, None) or (None, reason). Whole file, every line parsed."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError as e:
        return None, "results log %s unreadable: %s" % (path, e)
    out = []
    for ln in lines:
        try:
            r = json.loads(ln)
        except ValueError:
            continue
        if isinstance(r, dict) and r.get("canary") == CANARY_NAME:
            out.append(r)
    return out, None


def leg_b(records, window):
    """FAIL iff one BINGX|NC* key is paged (`coin_silent`) on two different UTC dates inside `window`."""
    start, end = window
    stamped = [(utc_epoch(r.get("at")), r) for r in records]
    stamped = [(t, r) for t, r in stamped if t is not None]
    inside = [(t, r) for t, r in stamped if start <= t <= end]
    dates_by_key, capped = {}, 0
    for t, r in inside:
        m = r.get("metrics") if isinstance(r.get("metrics"), dict) else {}
        keys = m.get("coin_silent")
        n = m.get("coin_silent_n")
        if not isinstance(keys, list):
            continue
        if type(n) is int and n > len(keys):
            capped += 1
        for k in keys:
            if isinstance(k, str) and _KEY_RE.match(k):
                dates_by_key.setdefault(k, set()).add(utc_date(t))
    repeat = {k: sorted(v) for k, v in sorted(dates_by_key.items()) if len(v) >= 2}
    leg = {"window": [utc_date(start), utc_date(end)], "records_in_window": len(inside),
           "bingx_nc_keys_paged": len(dates_by_key), "keys_on_2plus_dates": len(repeat),
           "dates_with_a_page": len({d for v in dates_by_key.values() for d in v}),
           "repeat_sample": dict(list(repeat.items())[:SAMPLE_MAX]), "capped_records": capped}
    if repeat:
        leg["verdict"] = "FAIL"
        leg["reason"] = "%d BINGX|NC* key(s) paged on two or more UTC dates" % len(repeat)
        return leg
    times = [t for t, _ in stamped]
    if not inside or min(times) > start + COVERAGE_SLACK_S or max(times) < end - COVERAGE_SLACK_S:
        leg["verdict"] = "INDETERMINATE"
        leg["reason"] = "the canary's records do not cover the window (oldest %s, newest %s)" % (
            utc_date(min(times)) if times else None, utc_date(max(times)) if times else None)
    elif capped:
        leg["verdict"] = "INDETERMINATE"
        leg["reason"] = "%d record(s) carried a capped coin_silent list — absence is unprovable" % capped
    else:
        leg["verdict"] = "PASS"
    return leg


def leg_c(ban_rows, instrument_rows):
    """FAIL iff a BingX ban row was recorded after DEPLOY_AT; INDETERMINATE if the instrument went dark."""
    try:
        bans = [{"code": r[0], "caller": r[1], "n": int(r[2])} for r in ban_rows]
        inst = int(instrument_rows[0][1]) if instrument_rows and instrument_rows[0][0] == "n" else None
    except (IndexError, ValueError):
        return {"verdict": "INDETERMINATE", "reason": "rate_limit_events rows outside the contract"}
    total = sum(b["n"] for b in bans)
    leg = {"ban_rows": total, "by_caller": bans[:SAMPLE_MAX], "bingx_rows_since_deploy": inst}
    if total > 0:
        leg["verdict"] = "FAIL"
        leg["reason"] = "%d BingX ban row(s) after deploy_at" % total
    elif not R0_3_INSTRUMENT_LIVE or inst is None or inst == 0:
        leg["verdict"] = "INDETERMINATE"
        leg["reason"] = "rate_limit_events wrote no BingX row since deploy_at — a dark instrument proves nothing"
    else:
        leg["verdict"] = "PASS"
    return leg


def aggregate(legs):
    vs = [legs[k]["verdict"] for k in sorted(legs)]
    if "FAIL" in vs:
        return "FAIL"
    return "PASS" if vs and all(v == "PASS" for v in vs) else "INDETERMINATE"


def evaluate(eff, now, bundle_stdout, bundle_err, records, records_err):
    """Pure: everything gathered -> (verdict, metrics). Leg B is judged on its own either way."""
    legs = {}
    snap = {"problems": [bundle_err] if bundle_err else []}
    if not bundle_err:
        b = parse_bundle(bundle_stdout)
        snap = {"ro": b["ro"], "problems": snapshot_problems(b)}
    if snap["problems"]:
        why = "snapshot unusable: " + "; ".join(snap["problems"])[:300]
        legs["A"] = {"verdict": "INDETERMINATE", "reason": why}
        legs["C"] = {"verdict": "INDETERMINATE", "reason": why}
    else:
        legs["A"] = leg_a(b["sec"]["cohort"], eff["deploy_at"])
        legs["C"] = leg_c(b["sec"]["bans"], b["sec"]["instrument"])
    if records_err:
        legs["B"] = {"verdict": "INDETERMINATE", "reason": records_err}
    else:
        legs["B"] = leg_b(records, eff["leg_b_window"])
    metrics = {"legs": legs, "snapshot": snap, "deploy_at": eff["deploy_at"], "now": int(now),
               "leg_b_window_overridden": eff["leg_b_window"] != LEG_B_WINDOW}
    return aggregate(legs), fit_metrics(metrics)


def fit_metrics(m):
    """<= METRICS_MAX_BYTES: shed the samples first, then the snapshot detail."""
    def size(x):
        return len(json.dumps(x, sort_keys=True).encode("utf-8"))
    for leg, key in (("B", "repeat_sample"), ("A", "unfilled_sample"), ("C", "by_caller")):
        if size(m) <= METRICS_MAX_BYTES:
            break
        node = m.get("legs", {}).get(leg, {})
        if key in node:
            node[key] = "(shed for size)"
    if size(m) > METRICS_MAX_BYTES:
        m["snapshot"] = {"problems": ["(shed for size)"]}
    return m


# ── the live run ─────────────────────────────────────────────────────────────────────────────

def run_bundle(sql):
    try:
        p = subprocess.run(shlex.split(PSQL_CMD), input=sql, capture_output=True, encoding="utf-8",
                           errors="replace", timeout=PSQL_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError) as e:
        return None, "psql could not run: %s: %s" % (type(e).__name__, str(e)[:160])
    if p.returncode != 0:
        return None, "psql rc=%d: %s" % (p.returncode, p.stderr.strip()[:240])
    return p.stdout, None


def run(now, anchors, sandbox):
    eff, err = resolve_anchors(anchors, sandbox)
    if err:
        return "INDETERMINATE", {"reason": err}
    if not DEPLOY_AT:
        return "INDETERMINATE", {"reason": "DEPLOY_AT is unset — this file was installed before CH1's deploy"}
    canary = load_canary()
    if psql_identity(PSQL_CMD) != psql_identity(canary.PSQL_DEFAULT):
        return "INDETERMINATE", {"reason": "this read's psql identity %r is not the canary's %r"
                                 % (psql_identity(PSQL_CMD), psql_identity(canary.PSQL_DEFAULT))}
    import canary_result_log  # noqa: PLC0415 — beside this file, as installed and as in the repo
    records, records_err = read_records(canary_result_log.RESULTS_PATH)
    stdout, berr = None, None
    t0 = time.monotonic()
    try:
        em = canary.run_emitter(now)
        probs = clause_problems(canary, em.get("past_reach_clause"))
        if probs:
            berr = "emitter: " + "; ".join(probs)
        else:
            stdout, berr = run_bundle(build_bundle(em["past_reach_clause"]))
    except canary.Indeterminate as e:
        berr = "emitter: %s" % str(e)[:240]
    verdict, metrics = evaluate(eff, now, stdout, berr, records, records_err)
    metrics["db_s"] = round(time.monotonic() - t0, 1)
    metrics["sandbox"] = bool(sandbox)
    return verdict, fit_metrics(metrics)


def emit(verdict, metrics):
    """The two contract lines, the token last."""
    return ["OWED_READ_METRICS=" + json.dumps(metrics, sort_keys=True, separators=(",", ":")),
            "OWED_READ_VERDICT=" + verdict]


def main(argv=None):
    ap = argparse.ArgumentParser(description="owed read: venue-closed-catchup")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--now", type=int)
    ap.add_argument("--sandbox", action="store_true")
    a = ap.parse_args(sys.argv[1:] if argv is None else argv)
    if a.self_test:
        return self_test()
    if not a.run or a.now is None:
        ap.error("the runner invokes --run --now EPOCH with the anchors on stdin")
    try:
        anchors = json.loads(sys.stdin.read() or "null")
        verdict, metrics = run(a.now, anchors, a.sandbox)
    except Exception as e:  # noqa: BLE001 — an unexpected fault verified nothing
        verdict, metrics = "INDETERMINATE", {"reason": "fault %s: %s" % (type(e).__name__, str(e)[:200])}
    for name, leg in sorted((metrics.get("legs") or {}).items()):
        print("LEG %s %s %s" % (name, leg.get("verdict"), leg.get("reason", "")))
    for ln in emit(verdict, metrics):
        print(ln)
    return EXIT_FOR[verdict]


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

# Floor = the measured check count, so removing any scenario trips it.
_SELF_TEST_MIN_CHECKS = 50


def self_test():
    import tempfile
    failures, ran = [], []

    def check(name, fn):
        ran.append(name)
        try:
            ok = fn()
        except Exception as e:  # noqa: BLE001 — an assertion that raises is a crash, not a verdict
            failures.append(name)
            print("  [FAIL] %s (raised %s: %s)" % (name, type(e).__name__, str(e)[:160]))
            return
        if not ok:
            failures.append(name)
        print("  [%s] %s" % ("ok" if ok else "FAIL", name))

    canary = load_canary()
    D = DEPLOY_AT or 1793300000          # the self-test runs before the deploy stamp too
    EFF = json.loads(json.dumps(ANCHORS))
    EFF["deploy_at"] = D
    EFF["leg_b_window"] = [D + 72 * 3600, D + 6 * 86400]
    NOW = D + 6 * 86400 + 3600

    # ── contract constants ──
    check("the frozen cohort is the R0.2 count, unique and sorted",
          lambda: len(COHORT_IDS) == COHORT_N == 162 and COHORT_IDS == sorted(set(COHORT_IDS)))
    check("not_before = deploy_at + 6 d; leg B's window = [deploy_at + 72 h, not_before]",
          lambda: NOT_BEFORE - DEPLOY_AT == 6 * 86400 and LEG_B_WINDOW == [DEPLOY_AT + 72 * 3600, NOT_BEFORE])
    check("the psql identity (container, role, database) is the canary's own",
          lambda: psql_identity(PSQL_CMD) == psql_identity(canary.PSQL_DEFAULT)
          == ("crypto-quant-signal-mcp-postgres-1", "aoe_readonly", "signal_performance"))
    check("token -> exit code: PASS 0, FAIL 1, INDETERMINATE 3", lambda: EXIT_FOR == {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3})
    check("anchors fit the runner's 4 KiB row budget", lambda: len(json.dumps(ANCHORS).encode()) <= 4096)

    # ── anchors ──
    check("anchors equal to the pre-registration resolve to it",
          lambda: resolve_anchors(json.loads(json.dumps(ANCHORS)), False) == (ANCHORS, None))
    retuned = dict(ANCHORS, ban_codes=["418"])
    check("a registry row that retunes a rule is INDETERMINATE, naming the key",
          lambda: resolve_anchors(retuned, False)[0] is None and "ban_codes" in resolve_anchors(retuned, False)[1])
    shrunk = dict(ANCHORS, cohort_ids=COHORT_IDS[:-1])
    check("a registry row with a different cohort is refused", lambda: resolve_anchors(shrunk, False)[0] is None)
    ov = dict(ANCHORS, **{SANDBOX_KEY: {"leg_b_window": [1, 2]}})
    check("a sandbox override without --sandbox is refused", lambda: resolve_anchors(ov, False)[0] is None)
    check("under --sandbox the leg_b_window override is honoured",
          lambda: resolve_anchors(ov, True)[0]["leg_b_window"] == [1, 2])
    check("under --sandbox any other override key is refused",
          lambda: resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {"deploy_at": 1}}), True)[0] is None)
    check("under --sandbox a malformed window is refused",
          lambda: resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {"leg_b_window": [5, 1]}}), True)[0] is None)

    # ── the bundle ──
    CLAUSE = "((COALESCE(NULLIF(exchange,''),'HL') = 'BINGX' AND timeframe = '1h' AND created_at < 1789000000))"
    lines = build_bundle(CLAUSE, D).splitlines()
    check("one transaction: BEGIN REPEATABLE READ READ ONLY first, COMMIT last, ON_ERROR_STOP on",
          lambda: lines[0] == "\\set ON_ERROR_STOP on" and lines[1] == "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
          and lines[-1] == "COMMIT;" and sum(ln.startswith(("BEGIN", "COMMIT")) for ln in lines) == 2)
    check("the cohort statement carries the producer's clause and every frozen id, and no outcome value column",
          lambda: CLAUSE in lines[5] and all(str(i) in lines[5] for i in COHORT_IDS)
          and not [t for t in canary.OUTCOME_VALUE_TOKENS if t in "\n".join(lines).lower()])
    check("an emitted clause with a separator or an outcome value column is refused",
          lambda: clause_problems(canary, CLAUSE + "; DROP") and clause_problems(canary, "(pfe_price > 0)")
          and clause_problems(canary, None) and not clause_problems(canary, CLAUSE))

    # ── leg A ──
    def rows(spec):
        """spec: id -> (filled_at|None, past)."""
        return [[str(i), "" if f is None else str(f), "1" if p else "0"] for i, (f, p) in sorted(spec.items())]
    all_after = {i: (D + 3600, False) for i in COHORT_IDS}
    check("A: every frozen row filled after deploy_at -> PASS", lambda: leg_a(rows(all_after), D)["verdict"] == "PASS")
    one = {**all_after, COHORT_IDS[7]: (None, False)}
    check("A BREAK: one in-reach frozen row still unfilled -> FAIL naming it",
          lambda: leg_a(rows(one), D)["verdict"] == "FAIL" and leg_a(rows(one), D)["unfilled_sample"] == [COHORT_IDS[7]])
    pre = {**all_after, COHORT_IDS[0]: (D - 60, False)}
    check("A: a row filled at or before deploy_at is reported apart, never a FAIL (CORRECTION 1)",
          lambda: leg_a(rows(pre), D)["verdict"] == "PASS" and leg_a(rows(pre), D)["filled_before_deploy"] == 1)
    past = {**all_after, COHORT_IDS[1]: (None, True)}
    check("A: an unfilled row that crossed reach is reported, never a FAIL",
          lambda: leg_a(rows(past), D)["verdict"] == "PASS" and leg_a(rows(past), D)["crossed_reach"] == 1)
    gone = {i: (None, True) for i in COHORT_IDS}
    check("A: every row past reach -> INDETERMINATE (an empty in-reach cohort proves nothing)",
          lambda: leg_a(rows(gone), D)["verdict"] == "INDETERMINATE")
    short = {i: v for i, v in all_after.items() if i != COHORT_IDS[-1]}
    check("A: a frozen id absent from signals -> INDETERMINATE", lambda: leg_a(rows(short), D)["verdict"] == "INDETERMINATE")
    check("A: a found failure beats an absent id -> FAIL",
          lambda: leg_a(rows({**short, COHORT_IDS[3]: (None, False)}), D)["verdict"] == "FAIL")
    check("A: a row outside the frozen cohort -> INDETERMINATE",
          lambda: leg_a(rows({**all_after, 42: (None, False)}), D)["verdict"] == "INDETERMINATE")
    check("A: a malformed row -> INDETERMINATE", lambda: leg_a([["x", "", "0"]], D)["verdict"] == "INDETERMINATE")

    # ── leg B ──
    def rec(t, keys, n=None):
        m = {"coin_silent": keys, "coin_silent_n": len(keys) if n is None else n}
        return {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t)), "canary": CANARY_NAME, "metrics": m}
    W = EFF["leg_b_window"]
    hourly = [rec(t, []) for t in range(W[0] - 3600, W[1] + 3600, 3600)]
    check("B: hourly records across the window, no BINGX page -> PASS", lambda: leg_b(hourly, W)["verdict"] == "PASS")
    d1, d2 = W[0] + 15 * 3600, W[0] + 39 * 3600
    rep = hourly + [rec(d1, ["BINGX|NCSKCME2USD"]), rec(d2, ["BINGX|NCSKCME2USD", "HL|SKHY"])]
    check("B BREAK: one BINGX|NC* key paged on two UTC dates -> FAIL",
          lambda: leg_b(rep, W)["verdict"] == "FAIL" and leg_b(rep, W)["keys_on_2plus_dates"] == 1)
    two = hourly + [rec(d1, ["BINGX|NCSKCME2USD"]), rec(d2, ["BINGX|NCSKSHEL2USD"])]
    check("B: two different keys on two dates is one date each -> PASS, the count reported",
          lambda: leg_b(two, W)["verdict"] == "PASS" and leg_b(two, W)["bingx_nc_keys_paged"] == 2)
    same_day = hourly + [rec(d1, ["BINGX|NCSKCME2USD"]), rec(d1 + 3600, ["BINGX|NCSKCME2USD"])]
    check("B: one key paged twice on ONE date -> PASS", lambda: leg_b(same_day, W)["verdict"] == "PASS")
    outside = hourly + [rec(W[0] - 86400, ["BINGX|NCSKCME2USD"]), rec(d1, ["BINGX|NCSKCME2USD"])]
    check("B: a page before the window does not count", lambda: leg_b(outside, W)["verdict"] == "PASS")
    other = hourly + [rec(d1, ["HL|SKHY"]), rec(d2, ["HL|SKHY"])]
    check("B: a non-BINGX key on two dates is not this leg's", lambda: leg_b(other, W)["verdict"] == "PASS")
    late = [r for r in hourly if utc_epoch(r["at"]) > W[0] + 3 * 3600]
    check("B: records that start after the window -> INDETERMINATE (rotation)", lambda: leg_b(late, W)["verdict"] == "INDETERMINATE")
    check("B: no records at all -> INDETERMINATE", lambda: leg_b([], W)["verdict"] == "INDETERMINATE")
    capped = hourly + [rec(d1, ["HL|A"] * 15, n=40)]
    check("B: a capped coin_silent list -> INDETERMINATE (absence unprovable)",
          lambda: leg_b(capped, W)["verdict"] == "INDETERMINATE")
    check("B: a found repeat beats a capped record -> FAIL", lambda: leg_b(capped + rep[-2:], W)["verdict"] == "FAIL")
    # The pre-fix series (vault canary-results.jsonl, 10-21 → 10-28), as a live-shaped break.
    pre_fix = [rec(calendar.timegm((2026, 10, 21, 16, 13, 2, 0, 0, 0)), ["BINGX|NCSKCME2USD", "BINGX|NCSKKVUE2USD"]),
               rec(calendar.timegm((2026, 10, 22, 16, 13, 2, 0, 0, 0)), ["BINGX|NCSKCME2USD"]),
               rec(calendar.timegm((2026, 10, 28, 16, 13, 2, 0, 0, 0)), ["BINGX|NCSKCME2USD"])]
    pw = [calendar.timegm((2026, 10, 21, 0, 0, 0, 0, 0, 0)), calendar.timegm((2026, 10, 28, 23, 0, 0, 0, 0, 0))]
    check("B: the measured pre-fix pages (10-21/22/28) FAIL the leg", lambda: leg_b(pre_fix, pw)["verdict"] == "FAIL")

    # ── leg C ──
    check("C: no ban row and a live instrument -> PASS", lambda: leg_c([], [["n", "57"]])["verdict"] == "PASS")
    check("C BREAK: one 109429 ban row after deploy -> FAIL, by caller",
          lambda: leg_c([["109429", "backfill_outcomes_cron", "1"]], [["n", "58"]])["verdict"] == "FAIL"
          and leg_c([["109429", "backfill_outcomes_cron", "1"]], [["n", "58"]])["by_caller"][0]["caller"] == "backfill_outcomes_cron")
    check("C: a dark instrument (0 BingX rows since deploy) -> INDETERMINATE",
          lambda: leg_c([], [["n", "0"]])["verdict"] == "INDETERMINATE")
    check("C: a malformed count -> INDETERMINATE", lambda: leg_c([], [["n", "x"]])["verdict"] == "INDETERMINATE")

    # ── the whole snapshot ──
    def stdout_for(cohort, bans=(), inst=("n|40",), ro="on", end=True, drop=None):
        out = ["MARK|ro|%s" % ro]
        for name, rws in (("cohort", ["|".join(r) for r in cohort]), ("bans", list(bans)), ("instrument", list(inst))):
            if name == drop:
                continue
            out.append("MARK|sec|%s" % name)
            out += rws
        if end:
            out.append("MARK|end")
        return "\n".join(out) + "\n"
    good = stdout_for(rows(all_after))
    v, m = evaluate(EFF, NOW, good, None, hourly, None)
    check("all three legs clean -> PASS", lambda: v == "PASS" and m["snapshot"]["problems"] == [])
    v, m = evaluate(EFF, NOW, stdout_for(rows(all_after), ro="off"), None, hourly, None)
    check("a snapshot whose transaction is not read-only -> INDETERMINATE", lambda: v == "INDETERMINATE")
    v, m = evaluate(EFF, NOW, stdout_for(rows(all_after), end=False), None, hourly, None)
    check("a bundle that never reached MARK|end -> INDETERMINATE", lambda: v == "INDETERMINATE")
    v, m = evaluate(EFF, NOW, stdout_for(rows(all_after), drop="instrument"), None, hourly, None)
    check("a missing result set -> INDETERMINATE", lambda: v == "INDETERMINATE")
    v, m = evaluate(EFF, NOW, None, "psql rc=2: could not connect", rep, None)
    check("leg B is judged even when the database is unreachable: a B FAIL is a FAIL",
          lambda: v == "FAIL" and m["legs"]["B"]["verdict"] == "FAIL")
    v, m = evaluate(EFF, NOW, good, None, None, "results log unreadable")
    check("an unreadable results log blinds leg B alone -> INDETERMINATE", lambda: v == "INDETERMINATE"
          and m["legs"]["A"]["verdict"] == "PASS")

    # ── metrics + output contract ──
    many = hourly + [rec(W[0] + 3600 * k, ["BINGX|NC%dX" % i for i in range(15)]) for k in range(0, 60, 24)]
    v, m = evaluate(EFF, NOW, stdout_for(rows({i: (None, False) for i in COHORT_IDS})), None, many, None)
    check("metrics stay <= 4 KiB however much the legs found",
          lambda: len(json.dumps(m, sort_keys=True).encode()) <= METRICS_MAX_BYTES)
    reserved = ("read_id", "wave", "not_before", "expires_at", "attempt", "expired", "script", "duration_s", "runner_reason")
    check("metrics never use a runner-owned key", lambda: not [k for k in m if k in reserved])
    out = emit(v, m)
    check("the output is exactly one metrics line then one verdict line",
          lambda: len(out) == 2 and out[0].startswith("OWED_READ_METRICS={") and out[1] == "OWED_READ_VERDICT=FAIL")
    tmp = tempfile.mkdtemp(prefix="owed-read-vcc.")
    p = os.path.join(tmp, "canary-results.jsonl")
    with open(p, "w", encoding="utf-8") as fh:
        fh.write("not json\n" + json.dumps({"canary": "other", "at": "2026-10-29T00:00:00Z"}) + "\n"
                 + json.dumps(rec(d1, ["BINGX|NCSKCME2USD"])) + "\n")
    recs, err = read_records(p)
    check("read_records keeps only this canary's parseable lines", lambda: err is None and len(recs) == 1)
    check("read_records names an unreadable file", lambda: read_records(os.path.join(tmp, "absent"))[0] is None)

    n = len(ran)
    ok = not failures and n >= _SELF_TEST_MIN_CHECKS
    if n < _SELF_TEST_MIN_CHECKS:
        print("  [FAIL] VACUITY: %d check(s) ran, floor is %d" % (n, _SELF_TEST_MIN_CHECKS))
    print("SELF-TEST: %s (%d check(s) ran, floor %d, %d failure(s))"
          % ("PASS" if ok else "FAIL", n, _SELF_TEST_MIN_CHECKS, len(failures)))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""owed-read-book-liveness-weekend.py — OPS-BOOK-LIVENESS-W2 CH3 (arc ARC-BOOK-LIVENESS-ALERT-TRUTH, T4).

Owner wave: OPS-BOOK-LIVENESS-W2. Its CH3 deleted the two LEVEL checks of book-liveness-canary.py — the
suppression FLOOR and the frozen-row RATE — because both paged on the gate's correct work, and the floor did
so on weekends above all, when venue-paused equities pile up suppressions. What pages now is a sentinel read
FROZEN or a gate miss (`book_liveness_defect`), and the counts ride unpaged in the result record. The first
full weekend after install #2 is the test. owed-read-runner.py runs this script when the registry row is due,
after the Tuesday run that follows that weekend; it answers ONE question and prints

    OWED_READ_METRICS=<json object, <= 4 KiB>
    OWED_READ_VERDICT=PASS|FAIL|INDETERMINATE

── THE RULE (pre-registered in the wave's spec, CH3 T4 — this file implements it, never retunes it) ──
  record   the EARLIEST `book-liveness` record whose `at` is in [RUN_FROM, RUN_UNTIL) — the canary's
           19:09Z cron run of TUESDAY (it records when it finishes; the window allows an hour).
  FAIL     its `level_breaches` > 0: the weekend paged book_liveness_defect.
  PASS     `level_breaches` == 0 AND the record carries the weekend — `suppressions.dates` holds
           SATURDAY, SUNDAY and MONDAY with a per-venue count list aligned to them — AND its `s2` counts.
  INDETERMINATE  no such record (missing); an unparseable line (it could be the record); a record whose
           own verdict is INDETERMINATE (a leg verified nothing, so "paged nothing" is not evidence); a
           record without `level_breaches`, without the weekend's suppressions, or without `s2`.

  The dates, fixed here: install #2 ran on 2026-11-12 or 2026-11-13 UTC; the first Saturday on or after it
  is 2026-11-14, so the weekend is 2026-11-14..16 and the run is Tuesday 2026-11-17 at 19:09Z.

    owed-read-book-liveness-weekend.py --run --now EPOCH [--sandbox] < anchors.json   (the runner)
    owed-read-book-liveness-weekend.py --self-test
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from datetime import datetime, timedelta, timezone

# ── the pre-registration (the wave's spec, CH3 T4) ──
WAVE = "OPS-BOOK-LIVENESS-W2"
CANARY = "book-liveness"
SATURDAY = "2026-11-14"
WEEKEND = ("2026-11-14", "2026-11-15", "2026-11-16")      # Saturday, Sunday, Monday
RUN_FROM = "2026-11-17T19:09:00Z"                         # Tuesday: the canary's cron minute (`9 19 * * *`)
RUN_FROM_EPOCH = 1794942540                                # = RUN_FROM; the self-test pins the two equal
RUN_WINDOW_S = 3600                                        # the run records when it finishes
RECORDS = "/var/lib/algovault-monitoring/canary-results.jsonl"
# What the registry row's `anchors` must equal. The registry is inert data that arrives by
# declaration-sync; a row can SELECT this read but can never retune it — a differing anchor is
# INDETERMINATE, and the fix is a reviewed edit of this file.
ANCHORS = {"canary": CANARY, "weekend": list(WEEKEND), "run_from": RUN_FROM, "records": RECORDS}
SANDBOX_KEY = "_sandbox_overrides"
# Nothing is overridable: the install's sandbox proof runs the registered read at a pinned `now`.
SANDBOX_OVERRIDABLE: tuple[str, ...] = ()

VERDICTS = ("PASS", "FAIL", "INDETERMINATE")
EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
METRICS_MAX_BYTES = 4096


def _epoch(stamp: str) -> int:
    return int(datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())


def _iso(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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
    if overrides is not None:
        if not sandbox:
            return None, "a sandbox override arrived without --sandbox — refused"
        bad = sorted(overrides) if isinstance(overrides, dict) else ["(not an object)"]
        bad = [k for k in bad if k not in SANDBOX_OVERRIDABLE]
        if bad:
            return None, "sandbox override key(s) %s are not overridable" % ",".join(bad)
    return json.loads(json.dumps(ANCHORS)), None


# ── the one leg: Tuesday's record ────────────────────────────────────────────────────────────

def find_record(lines, now, eff=ANCHORS):
    """-> (record dict, None) or (None, reason). The EARLIEST `eff["canary"]` record in [RUN_FROM, RUN_FROM +
    RUN_WINDOW_S) and at or before `now`. `lines` is the results file's lines, or None when unreadable."""
    if lines is None:
        return None, "the results file is absent or unreadable"
    lo = _epoch(eff["run_from"])
    best, bad = None, 0
    for ln in lines:
        if not ln.strip():
            continue
        try:
            d = json.loads(ln)
            if not isinstance(d, dict):
                raise ValueError("not an object")
        except ValueError:
            bad += 1
            continue
        if d.get("canary") != eff["canary"]:
            continue
        try:
            at = _epoch(d["at"])
        except (KeyError, TypeError, ValueError):
            bad += 1
            continue
        if not lo <= at < lo + RUN_WINDOW_S or at > now:
            continue
        if best is None or at < best[0]:
            best = (at, d)
    if bad:
        return None, "%d unparseable line(s) — one could be the run's record" % bad
    if best is None:
        return None, "no %s record in [%s, %s) at or before now" % (eff["canary"], eff["run_from"],
                                                                     _iso(lo + RUN_WINDOW_S))
    return best[1], None


def weekend_counts(supp, weekend):
    """-> ({venue: count over the weekend}, None) or (None, reason). The record must carry each weekend date
    with a per-venue list aligned to its own dates."""
    if not isinstance(supp, dict) or not isinstance(supp.get("dates"), list) or not isinstance(supp.get("by_venue"), dict):
        return None, "the record carries no suppressions {dates, by_venue}"
    dates = supp["dates"]
    missing = [d for d in weekend if d not in dates]
    if missing:
        return None, "the record's suppressions do not cover %s (dates %s..%s)" % (
            ",".join(missing), dates[0] if dates else "?", dates[-1] if dates else "?")
    out = {}
    for venue, counts in supp["by_venue"].items():
        if not isinstance(counts, list) or len(counts) != len(dates) or not all(isinstance(c, int) for c in counts):
            return None, "venue %s's suppressions are not a count per date" % venue
        out[venue] = sum(counts[dates.index(d)] for d in weekend)
    return out, None


def evaluate(now, lines, eff=ANCHORS):
    """Pure: the results file's lines -> (verdict, metrics)."""
    rec, why = find_record(lines, now, eff)
    metrics = {"now": int(now), "run_from": eff["run_from"], "weekend": list(eff["weekend"])}
    if rec is None:
        return "INDETERMINATE", fit_metrics(dict(metrics, reason=why))
    m = rec.get("metrics") if isinstance(rec.get("metrics"), dict) else {}
    metrics.update({"record_at": rec.get("at"), "record_verdict": rec.get("verdict"),
                    "level_breaches": m.get("level_breaches"), "defect_keys": m.get("defect_keys"),
                    "s2": m.get("s2"), "sentinel": m.get("sentinel")})
    lb = m.get("level_breaches")
    if isinstance(lb, int) and not isinstance(lb, bool) and lb > 0:
        return "FAIL", fit_metrics(dict(metrics, reason="the weekend paged book_liveness_defect: %d key(s)" % lb))
    if rec.get("verdict") == "INDETERMINATE":
        return "INDETERMINATE", fit_metrics(dict(metrics, reason="the run itself was INDETERMINATE: %s"
                                                 % str(m.get("reason") or "a leg verified nothing")[:200]))
    if lb != 0 or isinstance(lb, bool):
        return "INDETERMINATE", fit_metrics(dict(metrics, reason="the record carries no level_breaches"))
    weekend, why = weekend_counts(m.get("suppressions"), eff["weekend"])
    if weekend is None:
        return "INDETERMINATE", fit_metrics(dict(metrics, reason=why))
    metrics["weekend_suppressions"] = weekend
    if not isinstance(m.get("s2"), dict):
        return "INDETERMINATE", fit_metrics(dict(metrics, reason="the record carries no s2 counts"))
    return "PASS", fit_metrics(metrics)


def fit_metrics(m):
    """<= METRICS_MAX_BYTES: shed the per-venue detail first, then the page keys."""
    def size(x):
        return len(json.dumps(x, sort_keys=True).encode("utf-8"))
    for key in ("sentinel", "s2", "weekend_suppressions", "defect_keys"):
        if size(m) <= METRICS_MAX_BYTES:
            break
        if key in m:
            m[key] = "(shed for size)"
    return m


# ── the live run ─────────────────────────────────────────────────────────────────────────────

def read_lines(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read().splitlines()
    except OSError:
        return None


def run(now, anchors, sandbox):
    eff, err = resolve_anchors(anchors, sandbox)
    if err:
        return "INDETERMINATE", {"reason": err}
    verdict, metrics = evaluate(now, read_lines(eff["records"]), eff)
    metrics["sandbox"] = bool(sandbox)
    return verdict, fit_metrics(metrics)


def emit(verdict, metrics):
    """The two contract lines, the token last."""
    return ["OWED_READ_METRICS=" + json.dumps(metrics, sort_keys=True, separators=(",", ":")),
            "OWED_READ_VERDICT=" + verdict]


def main(argv=None):
    ap = argparse.ArgumentParser(description="owed read: book-liveness-weekend")
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
    if metrics.get("reason"):
        print("REASON %s" % metrics["reason"])
    for ln in emit(verdict, metrics):
        print(ln)
    return EXIT_FOR[verdict]


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

# Floor = the measured check count, so removing any scenario trips it.
_SELF_TEST_MIN_CHECKS = 30


def _load_canary():
    """The canary installed beside this read: its build_result_metrics and judge_defect build the record
    fixtures, so the read is tested against what the canary actually WRITES, not a shape copied by hand."""
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("book_liveness_canary", os.path.join(here, "book-liveness-canary.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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

    tmp = tempfile.mkdtemp(prefix="owed-read-blw.")
    NOW = RUN_FROM_EPOCH + 4800                    # the runner's first due tick: 20:27Z
    try:
        c = _load_canary()
        loaded = True
    except Exception as e:  # noqa: BLE001
        print("  [FAIL] book-liveness-canary.py and its siblings load beside this read (%s)" % e)
        loaded = False

    tuesday = datetime.strptime(RUN_FROM, "%Y-%m-%dT%H:%M:%SZ").date()

    def defect(states=("LIVE",), mode="enforce"):
        doc = {"mode": "sentinels", "sentinels": [{"venue": "V%d" % i, "coin": "BTC", "state": s, "reason": "r"}
                                                  for i, s in enumerate(states)]}
        return c.judge_defect(mode, doc, None, [], [], None, None)

    def record(at, states=("LIVE",), supp_rows=(("BINGX", "2026-11-15", 14), ("BITGET", "2026-11-14", 9)),
               today=tuesday, verdict=None, metrics=None):
        """One line exactly as the canary writes it: its own build_result_metrics through canary_result_log."""
        if metrics is None:
            d = defect(states)
            supp = c.suppressions_record([[v, day, str(n)] for v, day, n in supp_rows], c.record_dates(7, today))
            verdict = verdict or {"FAIL": "FAIL", "INDETERMINATE": "INDETERMINATE"}.get(d["verdict"], "PASS")
            metrics = c.build_result_metrics(verdict, c._token_exit_map()[verdict], "enforce", "a", "b", [], True, 78,
                                             defect=d, suppressions=supp)
        verdict = verdict or "PASS"
        return c._build_record(c.RESULT_CANARY, verdict, c._token_exit_map()[verdict], metrics, at=_iso(at))

    T = RUN_FROM_EPOCH + 75           # a cron run that took 75 s

    # ── the pre-registration ──
    check("SATURDAY is a Saturday and WEEKEND is Saturday, Sunday, Monday",
          lambda: datetime.strptime(SATURDAY, "%Y-%m-%d").weekday() == 5
          and list(WEEKEND) == [(datetime.strptime(SATURDAY, "%Y-%m-%d") + timedelta(days=i)).strftime("%Y-%m-%d")
                                for i in range(3)])
    check("RUN_FROM is the Tuesday after that Saturday, at the canary's cron minute 19:09Z",
          lambda: tuesday.weekday() == 1 and (tuesday - datetime.strptime(SATURDAY, "%Y-%m-%d").date()).days == 3
          and RUN_FROM.endswith("T19:09:00Z"))
    check("RUN_FROM_EPOCH is RUN_FROM", lambda: RUN_FROM_EPOCH == _epoch(RUN_FROM))
    check("the record's 7 dates on that Tuesday hold the whole weekend",
          lambda: all(d in c.record_dates(c.SUPPRESSION_RECORD_DAYS, tuesday) for d in WEEKEND))
    check("token -> exit code: PASS 0, FAIL 1, INDETERMINATE 3", lambda: EXIT_FOR == {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3})

    # ── anchors ──
    check("anchors equal to the pre-registration resolve to it",
          lambda: resolve_anchors(json.loads(json.dumps(ANCHORS)), False) == (ANCHORS, None))
    check("a registry row that retunes the read is INDETERMINATE, naming the key",
          lambda: resolve_anchors(dict(ANCHORS, run_from="2026-11-24T19:09:00Z"), False)[0] is None
          and "run_from" in resolve_anchors(dict(ANCHORS, run_from="2026-11-24T19:09:00Z"), False)[1])
    check("a sandbox override without --sandbox is refused",
          lambda: resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {}}), False)[0] is None)
    check("under --sandbox every override key is refused (nothing is overridable)",
          lambda: resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {"weekend": []}}), True)[0] is None
          and resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {}}), True)[0] == ANCHORS)

    # ── PASS ──
    v, m = evaluate(NOW, [record(T)])
    check("PASS: level_breaches 0, the weekend's suppressions and the s2 counts carried",
          lambda: v == "PASS" and m["weekend_suppressions"] == {"BINGX": 14, "BITGET": 9} and m["level_breaches"] == 0)
    v, m = evaluate(NOW, [record(T), record(T + 900, states=("FROZEN",))])
    check("the EARLIEST record in the window wins (a later manual run does not change it)", lambda: v == "PASS")
    v, m = evaluate(NOW, [record(T - 86400, states=("FROZEN",), today=tuesday - timedelta(days=1)), record(T)])
    check("Monday's run is not Tuesday's", lambda: v == "PASS")
    dead_fail = record(T, verdict="FAIL") if loaded else ""
    v, m = evaluate(NOW, [dead_fail])
    check("a FAIL run with level_breaches 0 (a dead-book page, another id) is still a PASS here",
          lambda: v == "PASS" and m["record_verdict"] == "FAIL")
    v, m = evaluate(NOW, ["", record(T)])
    check("a blank line is not a record and not a defect", lambda: v == "PASS")

    # ── FAIL ──
    v, m = evaluate(NOW, [record(T, states=("FROZEN", "LIVE"))])
    check("FAIL: the weekend paged book_liveness_defect (level_breaches 1)",
          lambda: v == "FAIL" and m["level_breaches"] == 1 and m["defect_keys"] == ["sentinel:V0"])
    v, m = evaluate(NOW, [record(T, states=("FROZEN", "UNREADABLE"))])
    check("FAIL dominates an UNREADABLE sentinel on the same run", lambda: v == "FAIL")

    # ── INDETERMINATE ──
    v, m = evaluate(NOW, [])
    check("INDETERMINATE: no record (missing)", lambda: v == "INDETERMINATE" and "no book-liveness record" in m["reason"])
    v, m = evaluate(NOW, None)
    check("INDETERMINATE: the results file absent", lambda: v == "INDETERMINATE")
    v, m = evaluate(NOW, [record(T + RUN_WINDOW_S)])
    check("INDETERMINATE: a record after the window is not the cron run's", lambda: v == "INDETERMINATE")
    v, m = evaluate(T - 1, [record(T)])
    check("INDETERMINATE: nothing at or before `now` (a replay before the run)", lambda: v == "INDETERMINATE")
    v, m = evaluate(NOW, [record(T), "{not json"])
    check("INDETERMINATE: an unparseable line (it could be the record)", lambda: v == "INDETERMINATE")
    v, m = evaluate(NOW, [record(T, states=("LIVE", "UNREADABLE"))])
    check("INDETERMINATE: a run whose own verdict is INDETERMINATE verified nothing",
          lambda: v == "INDETERMINATE" and m["level_breaches"] == 0 and "INDETERMINATE" in m["reason"])
    v, m = evaluate(NOW, [record(T, verdict="INDETERMINATE", metrics={"reason": "s2 rows query: timeout"})])
    check("INDETERMINATE: an early-return record ({reason} only)", lambda: v == "INDETERMINATE" and "timeout" in m["reason"])
    v, m = evaluate(NOW, [record(T, metrics={"mode": "enforce"})])
    check("INDETERMINATE: a record without level_breaches", lambda: v == "INDETERMINATE" and "level_breaches" in m["reason"])
    v, m = evaluate(NOW, [record(T, metrics={"level_breaches": 0, "s2": {}})])
    check("INDETERMINATE: a record without suppressions", lambda: v == "INDETERMINATE" and "suppressions" in m["reason"])
    v, m = evaluate(NOW, [record(T, today=tuesday + timedelta(days=5), supp_rows=())] if loaded else [])
    check("INDETERMINATE: suppressions that do not cover the weekend",
          lambda: v == "INDETERMINATE" and "do not cover" in m["reason"])
    v, m = evaluate(NOW, [record(T, metrics={"level_breaches": 0, "s2": {},
                                             "suppressions": {"dates": list(WEEKEND), "by_venue": {"X": [1]}}})])
    check("INDETERMINATE: a venue whose counts are not aligned to the dates",
          lambda: v == "INDETERMINATE" and "not a count per date" in m["reason"])
    v, m = evaluate(NOW, [record(T, metrics={"level_breaches": 0,
                                             "suppressions": {"dates": list(WEEKEND), "by_venue": {}}})])
    check("INDETERMINATE: a record without s2", lambda: v == "INDETERMINATE" and "s2" in m["reason"])
    v, m = evaluate(NOW, [record(T, metrics={"level_breaches": True, "s2": {},
                                             "suppressions": {"dates": list(WEEKEND), "by_venue": {}}})])
    check("a boolean level_breaches is not a count", lambda: v == "INDETERMINATE")

    # ── the live run's file read ──
    rp = os.path.join(tmp, "results.jsonl")
    with open(rp, "w", encoding="utf-8") as fh:
        fh.write(record(T) + "\n")
    check("read_lines: an absent file is None, never an empty list",
          lambda: read_lines(os.path.join(tmp, "nope")) is None and len(read_lines(rp)) == 1)
    v, m = evaluate(NOW, read_lines(rp), dict(ANCHORS, records=rp))
    check("end to end through the file: PASS", lambda: v == "PASS")

    # ── metrics + output contract ──
    big = {"level_breaches": 0, "s2": {"V%03d" % i: {"gate_miss": 0, "froze_after": 9, "unverifiable": 0} for i in range(200)},
           "sentinel": {"V%03d" % i: "LIVE" for i in range(200)},
           "suppressions": {"dates": list(WEEKEND), "by_venue": {"V%03d" % i: [1, 2, 3] for i in range(200)}}}
    v, m = evaluate(NOW, [record(T, metrics=big)])
    check("metrics stay <= 4 KiB however many venues", lambda: v == "PASS" and len(json.dumps(m, sort_keys=True).encode()) <= METRICS_MAX_BYTES)
    reserved = ("read_id", "wave", "not_before", "expires_at", "attempt", "expired", "script", "duration_s", "runner_reason")
    check("metrics never use a runner-owned key", lambda: not [k for k in m if k in reserved])
    out = emit(v, m)
    check("the output is exactly one metrics line then one verdict line",
          lambda: len(out) == 2 and out[0].startswith("OWED_READ_METRICS={") and out[1] == "OWED_READ_VERDICT=" + v)

    n = len(ran)
    ok = not failures and n >= _SELF_TEST_MIN_CHECKS
    if n < _SELF_TEST_MIN_CHECKS:
        print("  [FAIL] VACUITY: %d check(s) ran, floor is %d" % (n, _SELF_TEST_MIN_CHECKS))
    print("SELF-TEST: %s (%d check(s) ran, floor %d, %d failure(s))"
          % ("PASS" if ok else "FAIL", n, _SELF_TEST_MIN_CHECKS, len(failures)))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

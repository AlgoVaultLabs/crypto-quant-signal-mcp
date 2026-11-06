#!/usr/bin/env python3
"""owed-read-call-ledger-week-1.py — DECISION-CALL-V2-W5 CH2. Did the crash-safe anchor hold for a week?

Owner wave: DECISION-CALL-V2-W5. CH1 commits every logged pre_trade_check to two leaves (call_ledger, 055);
CH2 anchors them nightly on the call-ledger registry (publish-call-ledger-batch, 00:13 UTC) and moves the signal
publisher (00:05 UTC) onto the same crash-safe anchor (call_ledger_batches + merkle_batch_seals, 056). This read
checks the first week of both, one read-only snapshot, and prints

    OWED_READ_METRICS=<json object, <= 4 KiB>
    OWED_READ_VERDICT=PASS|FAIL|INDETERMINATE

── THE PRE-REGISTRATION (spec §9.7) ──
Due at the first call-ledger anchor + 7 d: seven nightly call-ledger batches `verified` with `recheck_ok_at`,
seven signal batches published by the new code, and no pending row left. `first_anchor_at` is a MEASURED anchor
(the chain time of the first verified call-ledger batch, call_ledger_batches.anchored_at): this read refuses a row
whose value differs from the table's own. Day D is the UTC date the first batch was SEALED; the week is the seven
nights D+1 … D+7, each read on its UTC date:
  call ledger  a night OWES a batch when a leaf was created on the day before it (after the first seal, for
               D+1). An owed night must have exactly one batch sealed that date, `verified`, with `recheck_ok_at`
               set and as many leaves carrying its batch id as its leaf_count. A night with no leaf the day
               before is QUIET — recorded, never owed (a day without one logged check seals nothing).
  signal       every night owes exactly one `verified` merkle_batch_seals row sealed that date, whose
               merkle_batches row carries the same root and signal count (the signal record grows daily).
  open rows    no call_ledger_batches and no merkle_batch_seals row is `sealed` or `sent`.
  PASS on all of it. FAIL names every break (with batch ids / dates). INDETERMINATE when the anchors are not this
  read's, the database cannot be read on one read-only snapshot, no batch is verified yet, or first_anchor_at is
  not the table's.

Every database statement runs in ONE `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction as
`aoe_readonly` (the app role's default ACL grants it SELECT on the tables the app creates). Stdlib only.

    owed-read-call-ledger-week-1.py --run --now EPOCH [--sandbox] < anchors.json   (the runner)
    owed-read-call-ledger-week-1.py --self-test
"""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import time

# ── the pre-registration (spec §9.7; never retuned by a registry row) ──
WAVE = "DECISION-CALL-V2-W5"
NIGHTS = 7                        # D+1 … D+7
WINDOW_H = 72                     # expires_at = not_before + 72 h
FIRST_ANCHOR_TOLERANCE_S = 1
ANCHOR_KEYS = ("first_anchor_at", "nights")
DAY_S = 86400

PSQL_CMD = ("docker exec -i crypto-quant-signal-mcp-postgres-1 psql -X -U aoe_readonly -d signal_performance "
            "-q -tA -F | -v ON_ERROR_STOP=1")
PSQL_TIMEOUT_S = 120
STATEMENT_TIMEOUT = "60s"

VERDICTS = ("PASS", "FAIL", "INDETERMINATE")
EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
METRICS_MAX_BYTES = 4096
SAMPLE_MAX = 6
SECTIONS = ("first", "cl_batches", "leaves", "sig_seals")
COLS = {"first": 3, "cl_batches": 7, "leaves": 2, "sig_seals": 5}


def utc_iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def utc_date(epoch):
    return time.strftime("%Y-%m-%d", time.gmtime(epoch))


def day_start(epoch):
    return epoch - epoch % DAY_S


# ── anchors ──────────────────────────────────────────────────────────────────────────────────

def resolve_anchors(anchors):
    """-> (anchors, None) or (None, reason). The rule constant must be this file's; first_anchor_at an epoch."""
    if not isinstance(anchors, dict):
        return None, "anchors are not a JSON object"
    keys = sorted(k for k in anchors if not str(k).startswith("_"))
    if keys != sorted(ANCHOR_KEYS):
        return None, "anchor keys %s are not %s" % (",".join(keys), ",".join(sorted(ANCHOR_KEYS)))
    if anchors["nights"] != NIGHTS:
        return None, "the registry's nights=%r differs from this read's pre-registration (%d)" % (anchors["nights"], NIGHTS)
    f = anchors["first_anchor_at"]
    if type(f) is not int or f < 1_793_900_000:
        return None, "first_anchor_at=%r is not an epoch after the wave" % (f,)
    return dict(anchors), None


# ── the one-snapshot bundle ──────────────────────────────────────────────────────────────────

def build_bundle():
    """psql stdin: ONE read-only repeatable-read transaction; each result set behind a MARK so a short read is
    visible. Times as epoch seconds."""
    ep = lambda c: "COALESCE(floor(extract(epoch FROM %s))::bigint::text, '')" % c  # noqa: E731
    p = ["\\set ON_ERROR_STOP on",
         "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
         "SET LOCAL statement_timeout = '%s';" % STATEMENT_TIMEOUT,
         "SELECT 'MARK|ro|' || current_setting('transaction_read_only');",
         "SELECT 'MARK|sec|first';",
         "SELECT b.batch_id, %s, %s FROM call_ledger_batches b WHERE b.state = 'verified' "
         "ORDER BY b.anchored_at, b.batch_id LIMIT 1;" % (ep("b.anchored_at"), ep("b.sealed_at")),
         "SELECT 'MARK|sec|cl_batches';",
         "SELECT b.batch_id, b.state, b.leaf_count, %s, %s, %s, "
         "(SELECT count(*) FROM call_ledger l WHERE l.batch_id = b.batch_id) "
         "FROM call_ledger_batches b ORDER BY b.batch_id;" % (ep("b.sealed_at"), ep("b.anchored_at"), ep("b.recheck_ok_at")),
         "SELECT 'MARK|sec|leaves';",
         "SELECT %s, COALESCE(l.batch_id::text, '') FROM call_ledger l ORDER BY l.created_at, l.id;" % ep("l.created_at"),
         "SELECT 'MARK|sec|sig_seals';",
         "SELECT s.batch_id, s.state, %s, s.signal_count, "
         "(EXISTS (SELECT 1 FROM merkle_batches mb WHERE mb.batch_id = s.batch_id AND mb.merkle_root = s.merkle_root "
         "AND mb.signal_count = s.signal_count))::int "
         "FROM merkle_batch_seals s ORDER BY s.batch_id;" % ep("s.sealed_at"),
         "SELECT 'MARK|end';",
         "COMMIT;"]
    return "\n".join(p) + "\n"


def parse_bundle(stdout):
    """-> (bundle dict, None) or (None, reason). Every section must be present, in order, and the read read-only."""
    b = {"ro": None, "first": [], "cl_batches": [], "leaves": [], "sig_seals": [], "end": False}
    sec = None
    for ln in (stdout or "").splitlines():
        if not ln.strip():
            continue
        if ln.startswith("MARK|ro|"):
            b["ro"] = ln.split("|", 2)[2]
        elif ln.startswith("MARK|sec|"):
            sec = ln.split("|", 2)[2]
        elif ln == "MARK|end":
            b["end"] = True
            sec = None
        elif sec in SECTIONS:
            b[sec].append(ln.split("|"))
        else:
            return None, "unexpected line outside a section: %r" % ln[:80]
    if b["ro"] != "on":
        return None, "the snapshot was not read-only (transaction_read_only=%r)" % b["ro"]
    if not b["end"]:
        return None, "the bundle ended before MARK|end (short read)"
    for s in SECTIONS:
        bad = [r for r in b[s] if len(r) != COLS[s]]
        if bad:
            return None, "%d %s row(s) do not have %d columns" % (len(bad), s, COLS[s])
    if len(b["first"]) > 1:
        return None, "the first-anchor section returned %d lines" % len(b["first"])
    return b, None


def _i(s):
    return int(s) if s not in ("", None) else None


# ── the read ─────────────────────────────────────────────────────────────────────────────────

def judge(b, a):
    """-> (breaks {name: [samples]}, nights [..], quiet n). The single derivation of every break."""
    br = {}

    def brk(name, sample):
        br.setdefault(name, []).append(sample)

    first_id, first_anchor, first_seal = _i(b["first"][0][0]), _i(b["first"][0][1]), _i(b["first"][0][2])
    d0 = day_start(first_seal)
    cl = [{"id": _i(r[0]), "state": r[1], "n": _i(r[2]), "sealed": _i(r[3]), "anchored": _i(r[4]), "recheck": _i(r[5]),
           "leaves": _i(r[6])} for r in b["cl_batches"]]
    sig = [{"id": _i(r[0]), "state": r[1], "sealed": _i(r[2]), "n": _i(r[3]), "mb": r[4] == "1"} for r in b["sig_seals"]]
    leaves = [(_i(r[0]), _i(r[1])) for r in b["leaves"]]

    for x in cl:
        if x["state"] in ("sealed", "sent"):
            brk("call_ledger_batch_open", x["id"])
        if x["state"] == "verified" and x["leaves"] != x["n"]:
            brk("call_ledger_batch_leaf_count", "%d:%s/%s" % (x["id"], x["leaves"], x["n"]))
    for x in sig:
        if x["state"] in ("sealed", "sent"):
            brk("signal_seal_open", x["id"])

    nights, quiet = [], 0
    for n in range(1, NIGHTS + 1):
        start = d0 + n * DAY_S
        date = utc_date(start)
        due = sum(1 for t, _ in leaves if t is not None and start - DAY_S <= t < start and t > first_seal)
        cl_n = [x for x in cl if x["sealed"] is not None and start <= x["sealed"] < start + DAY_S]
        sig_n = [x for x in sig if x["sealed"] is not None and start <= x["sealed"] < start + DAY_S]
        e = {"date": date, "leaves_due": due, "cl": [x["id"] for x in cl_n], "sig": [x["id"] for x in sig_n]}
        if len(cl_n) > 1:
            brk("call_ledger_two_seals_one_day", date)
        if due > 0:
            ok = [x for x in cl_n if x["state"] == "verified" and x["recheck"] is not None]
            if not cl_n:
                brk("call_ledger_night_missed", date)
            elif not ok:
                brk("call_ledger_night_not_verified_and_rechecked", date)
        elif not cl_n:
            quiet += 1
        if len(sig_n) != 1:
            brk("signal_night_count_not_one", "%s:%d" % (date, len(sig_n)))
        for x in sig_n:
            if x["state"] != "verified":
                brk("signal_night_not_verified", date)
            elif not x["mb"]:
                brk("signal_seal_without_matching_merkle_batch", x["id"])
        nights.append(e)
    return br, nights, quiet, (first_id, first_anchor, first_seal)


def evaluate(anchors, now, stdout, err):
    """-> (verdict, metrics). The single derivation of the verdict."""
    a, why = resolve_anchors(anchors)
    if why:
        return "INDETERMINATE", {"reason": why}
    if err:
        return "INDETERMINATE", {"reason": err}
    b, why = parse_bundle(stdout)
    if why:
        return "INDETERMINATE", {"reason": why}
    if not b["first"] or not b["first"][0][1] or not b["first"][0][2]:
        return "INDETERMINATE", {"reason": "no call-ledger batch is verified yet, so first_anchor_at is unverifiable"}
    if abs(int(b["first"][0][1]) - a["first_anchor_at"]) > FIRST_ANCHOR_TOLERANCE_S:
        return "INDETERMINATE", {"reason": "anchor first_anchor_at %d is not the table's first verified anchor %s"
                                 % (a["first_anchor_at"], b["first"][0][1])}
    breaks, nights, quiet, (fid, fan, fse) = judge(b, a)
    m = {"wave": WAVE, "now": utc_iso(now), "first_batch": fid, "first_anchor_at": utc_iso(fan),
         "first_sealed_at": utc_iso(fse), "nights": nights, "quiet_nights": quiet,
         "call_ledger_batches": len(b["cl_batches"]), "leaves": len(b["leaves"]), "signal_seals": len(b["sig_seals"]),
         "breaks": {k: {"n": len(v), "sample": v[:SAMPLE_MAX]} for k, v in sorted(breaks.items())}}
    return ("FAIL" if breaks else "PASS"), m


def fit_metrics(m):
    """The runner's 4 KiB budget: drop per-night batch ids before anything else, then samples."""
    def size(x):
        return len(json.dumps(x, sort_keys=True, separators=(",", ":")).encode())
    if size(m) <= METRICS_MAX_BYTES:
        return m
    m = json.loads(json.dumps(m))
    for e in m.get("nights") or []:
        e["cl"], e["sig"] = len(e["cl"]), len(e["sig"])
    m["_trimmed"] = "per-night batch ids replaced by counts to fit 4 KiB"
    if size(m) <= METRICS_MAX_BYTES:
        return m
    for v in (m.get("breaks") or {}).values():
        v.pop("sample", None)
    m["_trimmed"] += "; break samples dropped"
    return m


def run_bundle(sql):
    try:
        p = subprocess.run(shlex.split(PSQL_CMD), input=sql, capture_output=True, encoding="utf-8",
                           errors="replace", timeout=PSQL_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError) as e:
        return None, "psql could not run: %s: %s" % (type(e).__name__, str(e)[:160])
    if p.returncode != 0:
        return None, "psql rc=%d: %s" % (p.returncode, p.stderr.strip()[:240])
    return p.stdout, None


def run(now, anchors):
    _a, why = resolve_anchors(anchors)
    if why:
        return "INDETERMINATE", {"reason": why}
    t0 = time.monotonic()
    stdout, err = run_bundle(build_bundle())
    verdict, metrics = evaluate(anchors, now, stdout, err)
    metrics["db_s"] = round(time.monotonic() - t0, 1)
    return verdict, fit_metrics(metrics)


def emit(verdict, metrics):
    """The two contract lines, the token last."""
    return ["OWED_READ_METRICS=" + json.dumps(metrics, sort_keys=True, separators=(",", ":")),
            "OWED_READ_VERDICT=" + verdict]


def main(argv=None):
    ap = argparse.ArgumentParser(description="owed read: call-ledger-week-1")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--now", type=int)
    ap.add_argument("--sandbox", action="store_true", help="accepted for the runner contract; this read has no override")
    a = ap.parse_args(sys.argv[1:] if argv is None else argv)
    if a.self_test:
        return self_test()
    if not a.run or a.now is None:
        ap.error("the runner invokes --run --now EPOCH with the anchors on stdin")
    try:
        anchors = json.loads(sys.stdin.read() or "null")
        verdict, metrics = run(a.now, anchors)
    except Exception as e:  # noqa: BLE001 — an unexpected fault verified nothing
        verdict, metrics = "INDETERMINATE", {"reason": "fault %s: %s" % (type(e).__name__, str(e)[:200])}
    for ln in emit(verdict, metrics):
        print(ln)
    return EXIT_FOR[verdict]


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

_SELF_TEST_MIN_CHECKS = 28


def self_test():
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

    D = 1_794_009_600                   # 2026-11-07T00:00:00Z
    SEAL1 = D + 5 * 3600                # the §9.6 run, 05:00Z
    ANCH1 = SEAL1 + 4                   # its block time
    NOW = ANCH1 + 7 * DAY_S + 3600
    A = {"first_anchor_at": ANCH1, "nights": NIGHTS}

    def world(quiet=(), drop_cl=(), drop_sig=(), unrecheck=(), open_cl=False, open_sig=False, two_seals=None,
              leaf_short=None, sig_mismatch=None):
        """A clean week: one check (2 leaves) every 6 h, a call-ledger batch at 00:13 and a signal seal at 00:05."""
        cl = [[1, "verified", 2, SEAL1, ANCH1, ANCH1 + 30, 2]]
        lv = [[D + 3600, 1], [D + 3600, 1]]
        sg = []
        bid = 1
        for n in range(1, NIGHTS + 1):
            start = D + n * DAY_S
            prev = start - DAY_S
            k = 0
            if n not in quiet:
                for h in (6, 12, 18):
                    t = prev + h * 3600
                    if t > SEAL1:
                        k += 2
                        lv += [[t, None], [t, None]]
            if k and n not in drop_cl:
                bid += 1
                rc = "" if n in unrecheck else str(start + 800)
                cl.append([bid, "verified", k, start + 780, start + 784, rc, k if leaf_short != n else k - 1])
                for r in lv:
                    if r[1] is None:
                        r[1] = bid
            if two_seals == n:
                bid += 1
                cl.append([bid, "verified", 2, start + 9000, start + 9004, str(start + 9010), 2])
            if n not in drop_sig:
                sg.append([100 + n, "verified", start + 300, 40, 0 if sig_mismatch == n else 1])
        if open_cl:
            cl.append([bid + 1, "sent", 4, NOW - 600, "", "", 0])
        if open_sig:
            sg.append([200, "sealed", NOW - 900, 40, 0])
        return cl, lv, sg

    def stdout_for(w, ro="on", end=True, first=True):
        cl, lv, sg = w
        e = lambda x: "" if x in (None, "") else str(x)  # noqa: E731
        lines = ["MARK|ro|" + ro, "MARK|sec|first"]
        if first:
            lines.append("1|%d|%d" % (ANCH1, SEAL1))
        lines.append("MARK|sec|cl_batches")
        lines += ["|".join(e(x) for x in r) for r in cl]
        lines.append("MARK|sec|leaves")
        lines += ["%d|%s" % (t, e(b)) for t, b in lv]
        lines.append("MARK|sec|sig_seals")
        lines += ["|".join(e(x) for x in r) for r in sg]
        if end:
            lines.append("MARK|end")
        return "\n".join(lines) + "\n"

    ev = lambda w, **kw: evaluate(A, NOW, stdout_for(w, **kw), None)  # noqa: E731
    v, m = ev(world())
    check("contract constants: 7 nights, 72 h, exit codes",
          lambda: NIGHTS == 7 and WINDOW_H == 72 and EXIT_FOR == {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3})
    check("the psql identity is aoe_readonly on signal_performance, read through docker exec -i",
          lambda: shlex.split(PSQL_CMD)[:4] == ["docker", "exec", "-i", "crypto-quant-signal-mcp-postgres-1"]
          and "aoe_readonly" in PSQL_CMD and "signal_performance" in PSQL_CMD)
    check("the bundle is ONE repeatable-read read-only transaction with every MARK",
          lambda: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" in build_bundle()
          and all(("MARK|sec|" + s) in build_bundle() for s in SECTIONS) and "MARK|end" in build_bundle()
          and not any(w in build_bundle().upper() for w in ("INSERT ", "UPDATE ", "DELETE ", "ALTER ", "DROP ", "CREATE ")))
    check("the bundle never selects a salt, a record field or an odds value",
          lambda: not any(w in build_bundle() for w in ("salt", "p_timeout", "decision", "equity")))
    check("anchors equal to the pre-registration resolve", lambda: resolve_anchors(dict(A)) == (A, None))
    check("a retuned nights is INDETERMINATE", lambda: resolve_anchors(dict(A, nights=6))[0] is None)
    check("an extra anchor key is INDETERMINATE", lambda: resolve_anchors(dict(A, extra=1))[0] is None)
    check("a non-epoch first_anchor_at is INDETERMINATE", lambda: resolve_anchors(dict(A, first_anchor_at="x"))[0] is None)
    check("a clean week: PASS, seven owed nights, each with its batch and its signal seal",
          lambda: v == "PASS" and len(m["nights"]) == 7 and all(e["leaves_due"] > 0 and len(e["cl"]) == 1 and len(e["sig"]) == 1
                                                                 for e in m["nights"]) and m["quiet_nights"] == 0)
    check("the nights are D+1 … D+7 of the first SEAL's UTC date",
          lambda: [e["date"] for e in m["nights"]] == ["2026-11-%02d" % d for d in range(8, 15)])
    check("leaves before the first seal are not owed by night 1",
          lambda: m["nights"][0]["leaves_due"] == 6)
    vq, mq = ev(world(quiet=(3,)))
    check("a quiet day (no leaf) owes no batch: PASS, recorded as quiet",
          lambda: vq == "PASS" and mq["quiet_nights"] == 1 and mq["nights"][2]["leaves_due"] == 0)
    for name, w, key in (
            ("a night with leaves and no batch", world(drop_cl=(4,)), "call_ledger_night_missed"),
            ("a batch never rechecked", world(unrecheck=(5,)), "call_ledger_night_not_verified_and_rechecked"),
            ("a batch whose leaves are not its leaf_count", world(leaf_short=2), "call_ledger_batch_leaf_count"),
            ("two call-ledger seals on one UTC day", world(two_seals=6), "call_ledger_two_seals_one_day"),
            ("an open call-ledger batch left", world(open_cl=True), "call_ledger_batch_open"),
            ("a night without a signal seal", world(drop_sig=(7,)), "signal_night_count_not_one"),
            ("a signal seal whose merkle_batches row differs", world(sig_mismatch=2), "signal_seal_without_matching_merkle_batch"),
            ("an open signal seal left", world(open_sig=True), "signal_seal_open")):
        check("FAIL, named: " + name, lambda w=w, key=key: ev(w)[0] == "FAIL" and key in ev(w)[1]["breaks"])
    check("the FAIL names the date of a missed night",
          lambda: ev(world(drop_cl=(4,)))[1]["breaks"]["call_ledger_night_missed"]["sample"] == ["2026-11-11"])
    check("first_anchor_at not the table's: INDETERMINATE",
          lambda: evaluate(dict(A, first_anchor_at=ANCH1 + 10), NOW, stdout_for(world()), None)[0] == "INDETERMINATE")
    check("no verified batch yet: INDETERMINATE (the anchor is unverifiable)",
          lambda: ev(world(), first=False)[0] == "INDETERMINATE")
    check("a snapshot that was not read-only: INDETERMINATE", lambda: ev(world(), ro="off")[0] == "INDETERMINATE")
    check("a short read (no MARK|end): INDETERMINATE", lambda: ev(world(), end=False)[0] == "INDETERMINATE")
    check("psql failure: INDETERMINATE", lambda: evaluate(A, NOW, None, "psql rc=2: boom")[0] == "INDETERMINATE")
    big = world()
    big[1].extend([[D + 2 * DAY_S + 7, 3]] * 4000)
    vb, mb = ev(big)
    check("metrics stay within the runner's 4 KiB with many leaves",
          lambda: len(json.dumps(fit_metrics(mb), sort_keys=True, separators=(",", ":")).encode()) <= METRICS_MAX_BYTES)
    out = emit(v, m)
    check("emit: METRICS then the token, exactly two lines",
          lambda: len(out) == 2 and out[0].startswith("OWED_READ_METRICS={") and out[1] == "OWED_READ_VERDICT=PASS")

    print("self-test: %d checks, %d failed" % (len(ran), len(failures)))
    # One token, as the wrapper and the canary print theirs: a run under the floor verified less than it claims.
    if len(ran) < _SELF_TEST_MIN_CHECKS:
        print("SELF_TEST_VERDICT=INDETERMINATE — only %d checks ran (expected >= %d)" % (len(ran), _SELF_TEST_MIN_CHECKS))
        return 3
    if failures:
        print("SELF_TEST_VERDICT=FAIL — %s" % "; ".join(failures)[:400])
        return 1
    print("SELF_TEST_VERDICT=PASS — %d checks (contract · anchors · seven nights · quiet days · each break named · "
          "INDETERMINATE on every unreadable input · 4 KiB metrics · emit)" % len(ran))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""owed-read-regime-15m-sampler-trigger.py — REGIME-15M-SERVE-W1 CH3(b) (ARC-REGIME-15M T6). Is 15m snapshot demand real?

Owner wave: REGIME-15M-SERVE-W1. get_market_regime serves 15m live from this wave on. The snapshot-fed surfaces —
scan_market_regimes, pre_trade_check, the bar-close sampler, the regime track record — stay at 1h, 4h, 1d: whether
the sampler writes 15m snapshots is Mr.1's G2 decision, and it is taken from data, never a calendar. This read is
that data. Each runner tick (hourly on signal-1) it counts, since `anchors.since`:

  request_log     distinct EXTERNAL callers that called get_market_regime with timeframe 15m — the census's caller
                  identity (scripts/regime-census, EDGE-REGIME-CENSUS-W1): caller = left(md5('regime-census-v1:' ||
                  ip_hash || '|' || client_name), 12); a row with license_tier 'internal' is never external; a caller
                  with ANY is_automated row on any tool in the window is SYNTHETIC, never external.
  refusal_counts  distinct caller_keys refused timeframe 15m on scan_market_regimes or pre_trade_check (either refusal
                  reason) — demand the snapshot tools turn away. The table's resolution is the UTC day, so it counts
                  from the day that holds `since`; those two tools refuse 15m identically before and after this
                  wave's deploy, so the partial first day measures the same demand. `<none>`, `<other>` and
                  `<overflow>` are not caller identities and are never counted.

and prints ONE token line, then the runner's two contract lines:

    REGIME_15M_SAMPLER_TRIGGER=FIRED | PENDING | INDETERMINATE (<cause>)
    OWED_READ_METRICS=<json object, <= 4 KiB>
    OWED_READ_VERDICT=FAIL | INDETERMINATE

  FIRED          either leg reaches CALLERS_MIN (5) -> runner verdict FAIL: OWED_READ_FAIL pages Mr.1 that hour and
                 the terminal marker ends the read. Criteria: "FIRED — 15m snapshot demand met; Mr.1 decides 15m
                 snapshots (G2)".
  PENDING        below both bars -> runner INDETERMINATE: retried next tick. The runner's own expired INDETERMINATE
                 record at expires_at (not_before + 30 d) is the NOT_FIRED outcome.
  INDETERMINATE  the anchors are not this read's, the database could not be read on one read-only snapshot, or the
                 snapshot came back short or malformed -> runner INDETERMINATE.
FIRED never maps to PASS: a met bar is a decision owed, and FAIL is the runner's only paging verdict.

Every statement runs in ONE `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction as `aoe_readonly`.
Measured 2026-11-27: the request_log leg over 30 days (429k rows) takes 278 ms. Stdlib only.

    owed-read-regime-15m-sampler-trigger.py --run --now EPOCH [--sandbox] < anchors.json   (the runner)
    owed-read-regime-15m-sampler-trigger.py --self-test
"""
from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys
import time

# ── the bar (never retuned by a registry row) ──
WAVE = "REGIME-15M-SERVE-W1"
READ_ID = "regime-15m-sampler-trigger"
CALLERS_MIN = 5
SINCE_FLOOR_S = 1_795_737_600          # 2026-11-27T00:00:00Z, day 0: a since before the wave is refused
TOOL = "get_market_regime"
TIMEFRAME = "15m"
SNAPSHOT_TOOLS = ("scan_market_regimes", "pre_trade_check")
NON_IDENTITY_KEYS = ("<none>", "<other>", "<overflow>")
CALLER_SQL = "left(md5('regime-census-v1:' || coalesce(ip_hash, '') || '|' || coalesce(client_name, '')), 12)"
ANCHOR_KEYS = ("since", "callers_min")

TOKEN = "REGIME_15M_SAMPLER_TRIGGER="
TRIGGER_VERDICT = {"FIRED": "FAIL", "PENDING": "INDETERMINATE", "INDETERMINATE": "INDETERMINATE"}

PSQL_CMD = ("docker exec -i crypto-quant-signal-mcp-postgres-1 psql -X -U aoe_readonly -d signal_performance "
            "-q -tA -F | -v ON_ERROR_STOP=1")
PSQL_TIMEOUT_S = 120
STATEMENT_TIMEOUT = "60s"

EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
METRICS_MAX_BYTES = 4096
CAUSE_MAX_CHARS = 200
SECTIONS = {"request_log": 3, "refusal_counts": 4}


def utc_iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def utc_day(epoch):
    return time.strftime("%Y-%m-%d", time.gmtime(epoch))


# ── anchors ──────────────────────────────────────────────────────────────────────────────────

def resolve_anchors(anchors, now):
    """-> (anchors, None) or (None, reason). The bar must be this file's; since an epoch in [day 0, now]."""
    if not isinstance(anchors, dict):
        return None, "anchors are not a JSON object"
    keys = sorted(k for k in anchors if not str(k).startswith("_"))
    if keys != sorted(ANCHOR_KEYS):
        return None, "anchor keys %s are not %s" % (",".join(keys), ",".join(sorted(ANCHOR_KEYS)))
    if type(anchors["callers_min"]) is not int or anchors["callers_min"] != CALLERS_MIN:
        return None, "the registry's callers_min %r is not this read's bar %d" % (anchors["callers_min"], CALLERS_MIN)
    s = anchors["since"]
    if type(s) is not int or s < SINCE_FLOOR_S:
        return None, "since=%r is not an epoch on or after %s" % (s, utc_iso(SINCE_FLOOR_S))
    if type(now) is not int or now < s:
        return None, "now=%r is before since %s" % (now, utc_iso(s))
    return dict(anchors), None


# ── the one-snapshot bundle ──────────────────────────────────────────────────────────────────

def build_bundle(since, now):
    """psql stdin: ONE read-only repeatable-read transaction; each result behind a MARK so a short read is visible.
    The only values interpolated are two validated integers rendered by strftime."""
    lo, hi = utc_iso(since).replace("Z", ".000Z"), utc_iso(now).replace("Z", ".000Z")
    tools = ", ".join("'%s'" % t for t in SNAPSHOT_TOOLS)
    skip = ", ".join("'%s'" % k for k in NON_IDENTITY_KEYS)
    p = ["\\set ON_ERROR_STOP on",
         "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
         "SET LOCAL statement_timeout = '%s';" % STATEMENT_TIMEOUT,
         "SELECT 'MARK|ro|' || current_setting('transaction_read_only') || '|' || current_user;",
         "SELECT 'MARK|sec|request_log';",
         # external = non-internal row AND the caller has no is_automated row on any tool in the window (census)
         "WITH win AS (SELECT %s AS caller, tool_name, timeframe, license_tier, is_automated FROM request_log "
         "WHERE timestamp >= '%s' AND timestamp < '%s'), callers AS (SELECT caller, bool_or(is_automated) AS automated, "
         "count(*) FILTER (WHERE tool_name = '%s' AND timeframe = '%s' AND license_tier <> 'internal') AS asked "
         "FROM win GROUP BY caller) "
         "SELECT count(*) FILTER (WHERE asked > 0 AND NOT automated), count(*) FILTER (WHERE asked > 0 AND automated), "
         "COALESCE(sum(asked) FILTER (WHERE NOT automated), 0) FROM callers;" % (CALLER_SQL, lo, hi, TOOL, TIMEFRAME),
         "SELECT 'MARK|sec|refusal_counts';",
         "SELECT count(DISTINCT caller_key), count(DISTINCT caller_key) FILTER (WHERE tool = '%s'), "
         "count(DISTINCT caller_key) FILTER (WHERE tool = '%s'), COALESCE(sum(count), 0) FROM refusal_counts "
         "WHERE day >= DATE '%s' AND day <= DATE '%s' AND tool IN (%s) AND parameter = 'timeframe' AND value = '%s' "
         "AND caller_key NOT IN (%s);" % (SNAPSHOT_TOOLS[0], SNAPSHOT_TOOLS[1], utc_day(since), utc_day(now), tools,
                                          TIMEFRAME, skip),
         "SELECT 'MARK|end';",
         "COMMIT;"]
    return "\n".join(p) + "\n"


def parse_bundle(stdout):
    """-> (bundle dict, None) or (None, reason). Read-only, as aoe_readonly, every section once with one row of
    non-negative integers, in order, through MARK|end."""
    b = {"ro": None, "user": None, "end": False}
    rows = {k: [] for k in SECTIONS}
    order, sec = [], None
    for ln in (stdout or "").splitlines():
        if not ln.strip():
            continue
        if ln.startswith("MARK|ro|"):
            parts = ln.split("|")
            b["ro"], b["user"] = parts[2], (parts[3] if len(parts) > 3 else None)
        elif ln.startswith("MARK|sec|"):
            sec = ln.split("|", 2)[2]
            if sec not in SECTIONS:
                return None, "unknown section %r" % sec[:40]
            order.append(sec)
        elif ln == "MARK|end":
            b["end"], sec = True, None
        elif sec in SECTIONS:
            rows[sec].append(ln.split("|"))
        else:
            return None, "unexpected line outside a section: %r" % ln[:80]
    if b["ro"] != "on":
        return None, "the snapshot was not read-only (transaction_read_only=%r)" % b["ro"]
    if b["user"] != "aoe_readonly":
        return None, "the snapshot was not read as aoe_readonly (current_user=%r)" % b["user"]
    if not b["end"]:
        return None, "the bundle ended before MARK|end (short read)"
    if order != list(SECTIONS):
        return None, "sections %s are not %s" % (",".join(order), ",".join(SECTIONS))
    for sec, ncols in SECTIONS.items():
        if len(rows[sec]) != 1 or len(rows[sec][0]) != ncols:
            return None, "the %s section is not one row of %d columns" % (sec, ncols)
        cells = rows[sec][0]
        if not all(c.isdigit() for c in cells):
            return None, "the %s section is not non-negative integers: %r" % (sec, "|".join(cells)[:60])
        b[sec] = [int(c) for c in cells]
    return b, None


# ── the read ─────────────────────────────────────────────────────────────────────────────────

def evaluate(anchors, now, stdout, err):
    """-> (trigger, cause or None, metrics). The single derivation of the trigger; the verdict projects from it."""
    a, why = resolve_anchors(anchors, now)
    if why is None and err:
        why = err
    b = None
    if why is None:
        b, why = parse_bundle(stdout)
    if why:
        cause = " ".join(str(why).split())[:CAUSE_MAX_CHARS]
        return "INDETERMINATE", cause, {"trigger": "INDETERMINATE", "reason": cause}
    ext, synth, ext_rows = b["request_log"]
    keys, scan_keys, ptc_keys, refusals = b["refusal_counts"]
    fired_by = [leg for leg, n in (("request_log", ext), ("refusal_counts", keys)) if n >= CALLERS_MIN]
    trigger = "FIRED" if fired_by else "PENDING"
    m = {"trigger": trigger, "fired_by": fired_by, "callers_min": CALLERS_MIN, "owner_wave": WAVE,
         "since": utc_iso(a["since"]), "read_at": utc_iso(now),
         "request_log": {"external_callers": ext, "synthetic_callers": synth, "external_rows": ext_rows},
         "refusal_counts": {"caller_keys": keys, "scan_market_regimes_keys": scan_keys, "pre_trade_check_keys": ptc_keys,
                            "refusals": refusals, "from_day": utc_day(a["since"])}}
    if trigger == "FIRED":
        m["decision"] = "FIRED — 15m snapshot demand met; Mr.1 decides 15m snapshots (G2)"
    return trigger, None, m


def run_bundle(sql, cmd=None):
    """-> (stdout, None) or (None, reason). `cmd` is the self-test's seam; the runner path never passes it."""
    argv = shlex.split(PSQL_CMD) if cmd is None else cmd
    try:
        p = subprocess.run(argv, input=sql, capture_output=True, encoding="utf-8", errors="replace",
                           timeout=PSQL_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError) as e:
        return None, "psql could not run: %s: %s" % (type(e).__name__, str(e)[:160])
    if p.returncode != 0:
        return None, "psql rc=%d: %s" % (p.returncode, p.stderr.strip()[:240])
    return p.stdout, None


def run(now, anchors, cmd=None):
    a, why = resolve_anchors(anchors, now)
    if why:
        return evaluate(anchors, now, None, None)
    t0 = time.monotonic()
    stdout, err = run_bundle(build_bundle(a["since"], now), cmd)
    trigger, cause, metrics = evaluate(anchors, now, stdout, err)
    metrics["db_s"] = round(time.monotonic() - t0, 2)
    return trigger, cause, metrics


def emit(trigger, cause, metrics):
    """The token line, then METRICS, then the runner's verdict last."""
    token = TOKEN + trigger + (" (%s)" % cause if trigger == "INDETERMINATE" else "")
    text = json.dumps(metrics, sort_keys=True, separators=(",", ":"))
    if len(text.encode("utf-8")) > METRICS_MAX_BYTES:  # never reached by construction; refuse rather than truncate
        trigger, token = "INDETERMINATE", TOKEN + "INDETERMINATE (metrics exceed 4 KiB)"
        text = json.dumps({"trigger": "INDETERMINATE", "reason": "metrics exceed 4 KiB"}, separators=(",", ":"))
    return [token, "OWED_READ_METRICS=" + text, "OWED_READ_VERDICT=" + TRIGGER_VERDICT[trigger]]


def main(argv=None):
    ap = argparse.ArgumentParser(description="owed read: regime-15m-sampler-trigger")
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
        trigger, cause, metrics = run(a.now, anchors)
    except Exception as e:  # noqa: BLE001 — an unexpected fault verified nothing
        cause = "fault %s: %s" % (type(e).__name__, " ".join(str(e).split())[:160])
        trigger, metrics = "INDETERMINATE", {"trigger": "INDETERMINATE", "reason": cause}
    lines = emit(trigger, cause, metrics)
    for ln in lines:
        print(ln)
    return EXIT_FOR[lines[-1].split("=", 1)[1]]


# ── Self-test (hermetic: fixtures are psql's printed bundle; the run path uses a stub command) ─────────

_SELF_TEST_MIN_CHECKS = 38


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

    S = 1_795_860_000                          # 2026-11-28T10:00:00Z (a literal: no fixture leans on the constants)
    NOW = S + 3 * 86400 + 600
    A = {"since": S, "callers_min": CALLERS_MIN}

    def bundle(rl=(0, 0, 0), rc=(0, 0, 0, 0), ro="on", user="aoe_readonly", end=True, sections=None):
        sec = sections if sections is not None else [("request_log", rl), ("refusal_counts", rc)]
        lines = ["MARK|ro|%s|%s" % (ro, user)]
        for name, row in sec:
            lines += ["MARK|sec|" + name] + (["|".join(str(c) for c in row)] if row is not None else [])
        if end:
            lines.append("MARK|end")
        return "\n".join(lines) + "\n"

    def ev(stdout, err=None, anchors=None, now=NOW):
        return evaluate(A if anchors is None else anchors, now, stdout, err)

    sql = build_bundle(S, NOW)
    check("contract: bar 5, FIRED -> FAIL, PENDING -> INDETERMINATE, INDETERMINATE -> INDETERMINATE, exit codes",
          lambda: CALLERS_MIN == 5 and TRIGGER_VERDICT == {"FIRED": "FAIL", "PENDING": "INDETERMINATE",
                                                           "INDETERMINATE": "INDETERMINATE"}
          and EXIT_FOR == {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3})
    check("the psql identity is aoe_readonly on signal_performance, read through docker exec -i",
          lambda: shlex.split(PSQL_CMD)[:4] == ["docker", "exec", "-i", "crypto-quant-signal-mcp-postgres-1"]
          and "-U aoe_readonly" in PSQL_CMD and "-d signal_performance" in PSQL_CMD)
    check("the bundle is ONE repeatable-read read-only transaction with every MARK and no write verb",
          lambda: sql.count("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;") == 1
          and all(m in sql for m in ("MARK|ro|", "MARK|sec|request_log", "MARK|sec|refusal_counts", "MARK|end", "COMMIT;"))
          and not any(w in sql.upper() for w in ("INSERT ", "UPDATE ", "DELETE ", "ALTER ", "DROP ", "CREATE ", "TRUNCATE ")))
    check("request_log leg: the census caller identity, internal rows excluded, automated callers apart",
          lambda: CALLER_SQL in sql and "license_tier <> 'internal'" in sql and "bool_or(is_automated)" in sql
          and "tool_name = 'get_market_regime' AND timeframe = '15m'" in sql)
    check("request_log leg: the window is [since, now) in request_log's ISO text form",
          lambda: "timestamp >= '2026-11-28T10:00:00.000Z' AND timestamp < '2026-12-01T10:10:00.000Z'" in sql)
    check("refusal_counts leg: both snapshot tools, timeframe 15m, from since's UTC day, placeholders never counted",
          lambda: "tool IN ('scan_market_regimes', 'pre_trade_check')" in sql and "parameter = 'timeframe' AND value = '15m'" in sql
          and "day >= DATE '2026-11-28' AND day <= DATE '2026-12-01'" in sql
          and "caller_key NOT IN ('<none>', '<other>', '<overflow>')" in sql)
    check("anchors equal to the bar resolve", lambda: resolve_anchors(dict(A), NOW) == (A, None))
    check("a retuned callers_min is INDETERMINATE", lambda: resolve_anchors(dict(A, callers_min=4), NOW)[0] is None)
    check("a non-int callers_min (5.0) is INDETERMINATE",
          lambda: resolve_anchors(dict(A, callers_min=5.0), NOW)[0] is None)
    check("an extra anchor key is INDETERMINATE", lambda: resolve_anchors(dict(A, extra=1), NOW)[0] is None)
    check("a missing anchor key is INDETERMINATE", lambda: resolve_anchors({"since": S}, NOW)[0] is None)
    check("a since before day 0 (2026-11-27T00:00Z) is INDETERMINATE; day 0 itself resolves",
          lambda: resolve_anchors(dict(A, since=1_795_737_599), NOW)[0] is None
          and resolve_anchors(dict(A, since=1_795_737_600), NOW)[0] is not None)
    check("a non-integer since (string, bool) is INDETERMINATE",
          lambda: resolve_anchors(dict(A, since=str(S)), NOW)[0] is None and resolve_anchors(dict(A, since=True), NOW)[0] is None)
    check("now before since is INDETERMINATE", lambda: resolve_anchors(dict(A), S - 1)[0] is None)
    check("anchors that are not an object are INDETERMINATE", lambda: resolve_anchors(None, NOW)[0] is None)

    t, c, m = ev(bundle(rl=(5, 0, 9)))
    check("FIRED via request_log: 5 external callers (refusal_counts 0)",
          lambda: t == "FIRED" and c is None and m["fired_by"] == ["request_log"] and TRIGGER_VERDICT[t] == "FAIL"
          and m["request_log"] == {"external_callers": 5, "synthetic_callers": 0, "external_rows": 9})
    t2, _c2, m2 = ev(bundle(rc=(5, 4, 1, 11)))
    check("FIRED via refusal_counts: 5 distinct caller_keys across the two snapshot tools (request_log 0)",
          lambda: t2 == "FIRED" and m2["fired_by"] == ["refusal_counts"] and m2["refusal_counts"]["caller_keys"] == 5)
    check("FIRED on both legs names both",
          lambda: ev(bundle(rl=(7, 0, 7), rc=(6, 6, 0, 6)))[2]["fired_by"] == ["request_log", "refusal_counts"])
    t4, c4, m4 = ev(bundle(rl=(4, 0, 30), rc=(4, 2, 2, 40)))
    check("PENDING at 4 callers on each leg: runner INDETERMINATE (retry), no cause, nothing fired",
          lambda: t4 == "PENDING" and c4 is None and m4["fired_by"] == [] and TRIGGER_VERDICT[t4] == "INDETERMINATE")
    check("synthetic callers never count: 4 external + 50 automated is PENDING",
          lambda: ev(bundle(rl=(4, 50, 4)))[0] == "PENDING")
    check("many rows from few callers never count: 4 callers with 900 rows is PENDING",
          lambda: ev(bundle(rl=(4, 0, 900)))[0] == "PENDING")
    check("a FIRED record carries the decision line", lambda: m["decision"].startswith("FIRED — 15m snapshot demand met"))
    t5, c5, m5 = ev(None, err="psql rc=2: could not connect")
    check("unreadable: psql failure is INDETERMINATE with its cause",
          lambda: t5 == "INDETERMINATE" and c5.startswith("psql rc=2") and m5 == {"trigger": "INDETERMINATE", "reason": c5})
    for name, out in (("a snapshot that was not read-only", bundle(ro="off")),
                      ("a snapshot read as another role", bundle(user="postgres")),
                      ("a short read (no MARK|end)", bundle(end=False)),
                      ("a missing section", bundle(sections=[("request_log", (5, 0, 5))])),
                      ("sections out of order", bundle(sections=[("refusal_counts", (0, 0, 0, 0)), ("request_log", (5, 0, 5))])),
                      ("a section with no row", bundle(sections=[("request_log", None), ("refusal_counts", (0, 0, 0, 0))])),
                      ("a section with a missing column", bundle(rl=(5, 0)))):
        check("INDETERMINATE on " + name, lambda out=out: ev(out)[0] == "INDETERMINATE")
    check("INDETERMINATE on a non-integer cell, never a crash",
          lambda: ev(bundle(rl=("5", "x", "1")))[0] == "INDETERMINATE" and ev(bundle(rl=(-5, 0, 1)))[0] == "INDETERMINATE")
    check("INDETERMINATE on a line outside a section",
          lambda: ev("MARK|ro|on|aoe_readonly\nstray\n" + bundle().split("\n", 1)[1])[0] == "INDETERMINATE")
    check("emit: the token first, METRICS, the runner verdict last — FIRED bare, PENDING bare, INDETERMINATE (cause)",
          lambda: emit(t, c, m)[0] == "REGIME_15M_SAMPLER_TRIGGER=FIRED" and emit(t, c, m)[2] == "OWED_READ_VERDICT=FAIL"
          and emit(t4, c4, m4)[0] == "REGIME_15M_SAMPLER_TRIGGER=PENDING" and emit(t4, c4, m4)[2] == "OWED_READ_VERDICT=INDETERMINATE"
          and emit(t5, c5, m5)[0] == "REGIME_15M_SAMPLER_TRIGGER=INDETERMINATE (psql rc=2: could not connect)"
          and all(len(emit(*x)) == 3 and emit(*x)[1].startswith("OWED_READ_METRICS={") for x in ((t, c, m), (t4, c4, m4), (t5, c5, m5))))
    reserved = ("read_id", "wave", "not_before", "expires_at", "attempt", "expired", "script", "duration_s", "runner_reason")
    check("metrics stay within 4 KiB and use no runner-owned key",
          lambda: all(len(emit(*x)[1].encode()) <= METRICS_MAX_BYTES and not any(k in x[2] for k in reserved)
                      for x in ((t, c, m), (t4, c4, m4), (t5, c5, m5))))
    check("a multi-line cause is folded to one bounded line", lambda: "\n" not in ev(None, err="a\nb" + "c" * 900)[1]
          and len(ev(None, err="x" * 900)[1]) == CAUSE_MAX_CHARS)
    stub = [sys.executable, "-c", "import sys; sys.stdin.read(); sys.stdout.write(%r)" % bundle(rl=(6, 1, 8))]
    rt, _rc, rm = run(NOW, dict(A), cmd=stub)
    check("run(): the bundle goes through the command and FIRED comes back (stubbed psql)",
          lambda: rt == "FIRED" and rm["request_log"]["external_callers"] == 6 and "db_s" in rm)
    fail = [sys.executable, "-c", "import sys; sys.stdin.read(); sys.stderr.write('boom'); sys.exit(2)"]
    check("run(): a failing psql is INDETERMINATE (psql rc=2: boom)",
          lambda: run(NOW, dict(A), cmd=fail)[:2] == ("INDETERMINATE", "psql rc=2: boom"))
    check("run(): anchors that are not the bar never reach the database",
          lambda: run(NOW, dict(A, callers_min=3), cmd=["/nonexistent/psql"])[0] == "INDETERMINATE")

    print("self-test: %d checks, %d failed" % (len(ran), len(failures)))
    if len(ran) < _SELF_TEST_MIN_CHECKS:
        print("self-test: FAIL — only %d checks ran (floor %d)" % (len(ran), _SELF_TEST_MIN_CHECKS))
        failures.append("floor")
    if failures:
        print("SELF_TEST_VERDICT=FAIL — %d of %d checks failed" % (len(failures), len(ran)))
        return 1
    print("SELF_TEST_VERDICT=PASS — %d checks green" % len(ran))
    return 0


if __name__ == "__main__":
    sys.exit(main())

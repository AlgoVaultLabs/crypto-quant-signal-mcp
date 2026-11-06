#!/usr/bin/env python3
"""owed-read-autopub-devto-scoped-first-run.py — OPS-AUTOPUB-DEVTO-DECOUPLE-W1 CH1 R5. Did the first run under a
dev.to-only hold still publish the other channels?

Owner wave: OPS-AUTOPUB-DEVTO-DECOUPLE-W1. Its CH1 (algovault-editorial b30baad, GHA deploy run 42222384577;
/usr/local/bin/editorial-publish.sh installed 2026-11-06T13:04:27Z) scopes the publish hold:
- The env hold stays the kill switch (`all`).
- Every `devto-*` auto hold and the `devto-escalation-window` hold only the dev.to leg (`devto`).
- Under a devto hold the run goes on, the router skips the dev.to writer (`devto: HELD`), and the GitHub Discussion
  posts without a dev.to canonical.

The escalation window holds dev.to until 2026-12-05T06:21:45Z. So Mon 2026-11-09 is the first run day the scoped
path must carry. This read checks that slot in the editorial run-verdict ledger and prints

    OWED_READ_METRICS=<json object, <= 4 KiB>
    OWED_READ_VERDICT=PASS|FAIL|INDETERMINATE

  PASS          A record exists for slot 2026-11-09, written after the install, with verdict PUBLISHED, devto HELD
                and a github_discussion_url at github.com/AlgoVaultLabs/crypto-quant-signal-mcp/discussions/<n>.
  FAIL          No record PASSes, and one contradicts the decoupling:
                  - PUBLISHED under devto HELD with no such Discussion URL. The slot would count as served on a
                    Discussion the record cannot show.
                  - OPERATOR_HOLD while that day's run log names ONLY dev.to-scoped holds (`scope=devto`). A
                    dev.to-only hold stopped the whole run again.
  INDETERMINATE Everything else, retried every tick until expires_at:
                  - No record for the slot yet.
                  - A run under devto HELD stopped before its channels (REVIEW_PENDING, PUBLISH_FAILED, …). A
                    manual run may still publish the slot.
                  - No dev.to hold was in force, so the scoped path was not exercised. Examples: devto PUBLISHED
                    or another router token, or OPERATOR_HOLD under an `all` hold such as the env kill switch.
                  - A malformed ledger line (the slot's record may be that line), an unreadable ledger or log, or
                    anchors that are not this read's.

Read-only: the ledger file and that day's run logs. Stdlib only; Python >= 3.9.

    owed-read-autopub-devto-scoped-first-run.py --run --now EPOCH [--sandbox] < anchors.json   (the runner)
    owed-read-autopub-devto-scoped-first-run.py --self-test
"""
from __future__ import annotations

import argparse
import ast
import calendar
import json
import os
import re
import sys
import tempfile
import time

# ── The pre-registration (spec R5). A registry row can select this read, never retune it. ──
WAVE = "OPS-AUTOPUB-DEVTO-DECOUPLE-W1"
SLOT_DATE = "2026-11-09"
INSTALL_AT = 1793970267           # 2026-11-06T13:04:27Z: the /usr/local/bin/editorial-publish.sh install
VERDICTS_PATH = "/var/lib/algovault-editorial/run-verdicts.jsonl"
LOG_DIR = "/var/log/algovault-editorial"
ANCHORS = {"slot_date": SLOT_DATE, "install_at": INSTALL_AT, "verdicts_path": VERDICTS_PATH, "log_dir": LOG_DIR}
SANDBOX_KEY = "_sandbox_overrides"
SANDBOX_PATH_KEYS = ("verdicts_path", "log_dir")   # the only keys a --sandbox override may replace
# Pinned to lib/github_discussions.mjs REPO_OWNER / REPO_NAME in algovault-editorial.
DISCUSSION_URL_RE = re.compile(r"^https://github\.com/AlgoVaultLabs/crypto-quant-signal-mcp/discussions/[1-9][0-9]*$")
# The orchestrator's hold branch: log "PUBLISH_HOLD_ACTIVE: ${HOLD_LINES} held_run_days=…". HOLD_LINES is
# cadence-check's `HOLD reason=… since=… source=… scope=…` lines joined with ';'.
HOLD_LINE_RE = re.compile(r"PUBLISH_HOLD_ACTIVE: (.*?) held_run_days=")
ISO_AT_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z$")

VERDICTS = ("PASS", "FAIL", "INDETERMINATE")
EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
# owed-read-runner.py RESERVED_METRIC_KEYS. The runner turns any read whose metrics use one into INDETERMINATE,
# whatever its token says. Measured on this read's first sandbox tick: a `wave` key turned a PASS into
# INDETERMINATE. The self-test asserts that no metrics this read can emit use one, and that this mirror still
# equals the runner beside it.
RUNNER_RESERVED_METRIC_KEYS = ("read_id", "wave", "not_before", "expires_at", "attempt", "expired", "script",
                               "duration_s", "runner_reason")
METRICS_MAX_BYTES = 4096
SAMPLE_MAX = 8
LOG_MAX_BYTES = 4 * 1024 * 1024   # a run log is ~100 KiB; anything larger is read in part


def utc_iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def iso_epoch(s):
    """The ledger's `at` (Date.toISOString) -> epoch seconds, or None."""
    m = ISO_AT_RE.match(s) if isinstance(s, str) else None
    if not m:
        return None
    return calendar.timegm(time.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S"))


# ── anchors ──────────────────────────────────────────────────────────────────────────────────

def resolve_anchors(anchors, sandbox=False):
    """-> (resolved anchors, None) or (None, reason). Every anchor must equal this file's pre-registration. Under
    --sandbox, `_sandbox_overrides` may replace only the two paths, so a fixture can stand in for the host files."""
    if not isinstance(anchors, dict):
        return None, "anchors are not a JSON object"
    keys = sorted(k for k in anchors if not str(k).startswith("_"))
    if keys != sorted(ANCHORS):
        return None, "anchor keys %s are not %s" % (",".join(keys), ",".join(sorted(ANCHORS)))
    for k, want in ANCHORS.items():
        got = anchors[k]
        if type(got) is not type(want) or got != want:
            return None, "anchor %s=%r differs from this read's pre-registration %r" % (k, got, want)
    resolved = dict(ANCHORS)
    ov = anchors.get(SANDBOX_KEY)
    if ov is not None:
        if not sandbox:
            return None, "%s outside --sandbox (a production row may never carry overrides)" % SANDBOX_KEY
        if (not isinstance(ov, dict) or not set(ov) <= set(SANDBOX_PATH_KEYS)
                or not all(isinstance(v, str) and v.startswith("/") for v in ov.values())):
            return None, "%s may only replace %s with absolute paths" % (SANDBOX_KEY, "/".join(SANDBOX_PATH_KEYS))
        resolved.update(ov)
    return resolved, None


# ── the ledger ───────────────────────────────────────────────────────────────────────────────

def parse_ledger(text, slot_date, install_at):
    """-> (records of the slot written at/after the install, bad line numbers, pre-install count, line count).
    A line that is not a JSON object is BAD, and so is a record of the slot whose `at` cannot be read. Either
    could be the slot's own record, so the caller never treats an absence as proof while one exists."""
    recs, bad, pre, n = [], [], 0, 0
    for i, ln in enumerate((text or "").splitlines(), 1):
        if not ln.strip():
            continue
        n += 1
        try:
            r = json.loads(ln)
        except ValueError:
            bad.append(i)
            continue
        if not isinstance(r, dict):
            bad.append(i)
            continue
        if r.get("slot_date") != slot_date:
            continue
        at = iso_epoch(r.get("at"))
        if at is None:
            bad.append(i)
        elif at < install_at:
            pre += 1
        else:
            recs.append(r)
    return recs, bad, pre, n


def classify(r):
    """One record -> pass | fail_no_url | operator_hold | held_not_published | not_scoped."""
    v, d, url = r.get("verdict"), r.get("devto"), r.get("github_discussion_url")
    if v == "PUBLISHED" and d == "HELD":
        return "pass" if isinstance(url, str) and DISCUSSION_URL_RE.match(url) else "fail_no_url"
    if v == "OPERATOR_HOLD":
        return "operator_hold"
    if d == "HELD":
        return "held_not_published"
    return "not_scoped"


def parse_holds(lines):
    """PUBLISH_HOLD_ACTIVE log lines -> [{source, scope}] per hold named (None where the line does not say)."""
    holds = []
    for ln in lines:
        m = HOLD_LINE_RE.search(ln)
        if not m:
            continue
        for part in m.group(1).split(";"):
            part = part.strip()
            if not part:
                continue
            src = re.search(r"(?:^|\s)source=(\S+)", part)
            scope = re.search(r"(?:^|\s)scope=(\S+)", part)
            holds.append({"source": src.group(1) if src else None, "scope": scope.group(1) if scope else None})
    return holds


def judge_operator_hold(hold_lines, log_err):
    """-> (FAIL | INDETERMINATE, reason, holds). FAIL only when the day's log names holds, and every one is
    devto-scoped."""
    if log_err:
        return "INDETERMINATE", "OPERATOR_HOLD, and the day's run logs are unreadable: " + log_err, []
    holds = parse_holds(hold_lines)
    if not holds:
        return "INDETERMINATE", "OPERATOR_HOLD, and no run log of the day names the hold (PUBLISH_HOLD_ACTIVE)", []
    if any(h["scope"] is None for h in holds):
        return "INDETERMINATE", "OPERATOR_HOLD under a hold whose scope the log does not state", holds
    if any(h["scope"] != "devto" for h in holds):
        return ("INDETERMINATE", "OPERATOR_HOLD under an `all` hold (kill switch or a non-dev.to auto hold) — the "
                "scoped path was not exercised", holds)
    return ("FAIL", "OPERATOR_HOLD while every hold the run named was dev.to-scoped — a dev.to-only hold stopped "
            "the whole run", holds)


def summarize(r, c):
    return {"verdict": r.get("verdict"), "devto": r.get("devto"), "url": r.get("github_discussion_url"),
            "scheduled": r.get("scheduled"), "catch_up": r.get("catch_up"), "at": r.get("at"), "class": c}


def evaluate(anchors, now, ledger, ledger_err, hold_lines, log_err, sandbox=False):
    """-> (verdict, metrics). The single derivation of the verdict."""
    a, why = resolve_anchors(anchors, sandbox)
    if why:
        return "INDETERMINATE", {"reason": why}
    if ledger_err:
        return "INDETERMINATE", {"reason": ledger_err}
    recs, bad, pre, n = parse_ledger(ledger, a["slot_date"], a["install_at"])
    classes = [classify(r) for r in recs]
    m = {"slot_date": a["slot_date"], "now": utc_iso(now), "ledger_lines": n, "bad_lines": len(bad),
         "bad_line_sample": bad[:SAMPLE_MAX], "pre_install_ignored": pre, "slot_records": len(recs),
         "records": [summarize(r, c) for r, c in zip(recs, classes)][:SAMPLE_MAX]}
    if "pass" in classes:
        return "PASS", m
    if not n:
        return "INDETERMINATE", dict(m, reason="the ledger holds no record at all (an empty or truncated file)")
    if bad:
        return "INDETERMINATE", dict(m, reason="%d malformed ledger line(s) — the slot's record may be one of them" % len(bad))
    if "fail_no_url" in classes:
        return "FAIL", dict(m, reason="PUBLISHED under devto HELD, naming no AlgoVaultLabs/crypto-quant-signal-mcp "
                                      "Discussion URL")
    if "operator_hold" in classes:
        v, why, holds = judge_operator_hold(hold_lines, log_err)
        m["holds"] = holds[:SAMPLE_MAX]
        if v == "FAIL":
            return "FAIL", dict(m, reason=why)
        return "INDETERMINATE", dict(m, reason=why)
    if not recs:
        return "INDETERMINATE", dict(m, reason="no record for slot %s yet" % a["slot_date"])
    if "held_not_published" in classes:
        return "INDETERMINATE", dict(m, reason="dev.to was held but the run stopped before publishing its channels; "
                                               "a manual run may still publish the slot")
    return "INDETERMINATE", dict(m, reason="no dev.to hold was in force for the slot's runs — the scoped path was "
                                           "not exercised")


def fit_metrics(m):
    """The runner's 4 KiB budget: drop the record URLs, then the samples."""
    def size(x):
        return len(json.dumps(x, sort_keys=True, separators=(",", ":")).encode())
    if size(m) <= METRICS_MAX_BYTES:
        return m
    m = json.loads(json.dumps(m))
    for r in m.get("records") or []:
        r.pop("url", None)
    m["_trimmed"] = "record urls dropped to fit 4 KiB"
    if size(m) <= METRICS_MAX_BYTES:
        return m
    m["records"] = (m.get("records") or [])[:2]
    m.pop("holds", None)
    m.pop("bad_line_sample", None)
    m["_trimmed"] += "; samples cut"
    return m


# ── IO (read-only) ───────────────────────────────────────────────────────────────────────────

def read_ledger(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(), None
    except OSError as e:
        return None, "ledger %s unreadable: %s" % (path, type(e).__name__)


def read_hold_lines(log_dir, slot_date):
    """The PUBLISH_HOLD_ACTIVE lines from that day's run logs (run-YYYYMMDDT*.log)."""
    prefix = "run-%sT" % slot_date.replace("-", "")
    try:
        names = sorted(n for n in os.listdir(log_dir) if n.startswith(prefix) and n.endswith(".log"))
    except OSError as e:
        return [], "log dir %s unreadable: %s" % (log_dir, type(e).__name__)
    lines = []
    for name in names:
        try:
            with open(os.path.join(log_dir, name), "r", encoding="utf-8", errors="replace") as f:
                lines.extend(ln for ln in f.read(LOG_MAX_BYTES).splitlines() if "PUBLISH_HOLD_ACTIVE:" in ln)
        except OSError as e:
            return [], "run log %s unreadable: %s" % (name, type(e).__name__)
    return lines, None


def run(now, anchors, sandbox=False):
    a, why = resolve_anchors(anchors, sandbox)
    if why:
        return "INDETERMINATE", {"reason": why}
    ledger, ledger_err = read_ledger(a["verdicts_path"])
    hold_lines, log_err = read_hold_lines(a["log_dir"], a["slot_date"])
    verdict, metrics = evaluate(anchors, now, ledger, ledger_err, hold_lines, log_err, sandbox)
    if sandbox:
        metrics["sandbox"] = True
    return verdict, fit_metrics(metrics)


def emit(verdict, metrics):
    """The two contract lines, the token last."""
    return ["OWED_READ_METRICS=" + json.dumps(metrics, sort_keys=True, separators=(",", ":")),
            "OWED_READ_VERDICT=" + verdict]


def main(argv=None):
    ap = argparse.ArgumentParser(description="owed read: autopub-devto-scoped-first-run")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--now", type=int)
    ap.add_argument("--sandbox", action="store_true", help="honour anchors['_sandbox_overrides'] (the two paths)")
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
    for ln in emit(verdict, metrics):
        print(ln)
    return EXIT_FOR[verdict]


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

_SELF_TEST_MIN_CHECKS = 41


def runner_reserved_keys():
    """RESERVED_METRIC_KEYS as written in the owed-read-runner.py installed beside this read; None when absent."""
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "owed-read-runner.py")
    try:
        with open(p, "r", encoding="utf-8") as f:
            src = f.read()
    except OSError:
        return None
    m = re.search(r"^RESERVED_METRIC_KEYS = (\([^)]*\))", src, re.M)
    return ast.literal_eval(m.group(1)) if m else None


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

    A = dict(ANCHORS)
    NOW = INSTALL_AT + 3 * 86400
    URL = "https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/discussions/79"

    def rec(verdict="PUBLISHED", devto="HELD", url=URL, slot=SLOT_DATE, at="2026-11-09T02:04:11.120Z", **kw):
        r = {"slot_date": slot, "verdict": verdict, "catch_up": False, "scheduled": True, "run_day": True,
             "run_days": "Mon,Wed,Fri", "slug": "a-post", "rc": 0}
        if devto is not None:
            r["devto"] = devto
        if url is not None:
            r["github_discussion_url"] = url
        r["at"] = at
        r.update(kw)
        return json.dumps(r)

    # An earlier day's real shape (pre-wave, no devto field) in every ledger: other slots must never count.
    OLD = rec(verdict="OPERATOR_HOLD", devto=None, url=None, slot="2026-11-06", at="2026-11-06T02:00:00.551Z",
              run_day=False)

    emitted = []   # every metrics object a scenario produced — none may use a runner-owned key

    def ev(*lines, holds=(), log_err=None, ledger_err=None, anchors=None, sandbox=False):
        v_, m_ = evaluate(A if anchors is None else anchors, NOW, "\n".join((OLD,) + lines) + "\n", ledger_err,
                          list(holds), log_err, sandbox)
        emitted.append(m_)
        return v_, m_

    def run_kept(*args, **kw):
        v_, m_ = run(*args, **kw)
        emitted.append(m_)
        return v_, m_

    DEVTO_HOLD = ("[2026-11-09T02:00:03Z] PUBLISH_HOLD_ACTIVE: reason=devto-escalation-window since=2026-11-06 "
                  "source=window scope=devto; held_run_days=2 — nothing pulled, drafted or published")
    ENV_HOLD = ("[2026-11-09T02:00:03Z] PUBLISH_HOLD_ACTIVE: reason=manual since=2026-11-08 source=env scope=all;"
                "reason=devto-escalation-window since=2026-11-06 source=window scope=devto; held_run_days=1 — x")

    check("contract constants: slot 2026-11-09, install 2026-11-06T13:04:27Z, exit codes 0/1/3",
          lambda: SLOT_DATE == "2026-11-09" and utc_iso(INSTALL_AT) == "2026-11-06T13:04:27Z"
          and EXIT_FOR == {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3})
    check("the Discussion URL is pinned to AlgoVaultLabs/crypto-quant-signal-mcp's discussions",
          lambda: DISCUSSION_URL_RE.match(URL) and not DISCUSSION_URL_RE.match(URL.replace("https:", "http:"))
          and not DISCUSSION_URL_RE.match(URL.replace("crypto-quant-signal-mcp", "other-repo"))
          and not DISCUSSION_URL_RE.match(URL + "#x") and not DISCUSSION_URL_RE.match(URL[:-2] + "0"))
    check("anchors equal to the pre-registration resolve", lambda: resolve_anchors(dict(A)) == (A, None))
    check("a retuned slot_date is INDETERMINATE", lambda: ev(rec(), anchors=dict(A, slot_date="2026-11-10"))[0] == "INDETERMINATE")
    check("a retuned install_at (or one as a string) is INDETERMINATE",
          lambda: resolve_anchors(dict(A, install_at=INSTALL_AT - 1))[0] is None
          and resolve_anchors(dict(A, install_at=str(INSTALL_AT)))[0] is None)
    check("an extra or a missing anchor key is INDETERMINATE",
          lambda: resolve_anchors(dict(A, extra=1))[0] is None
          and resolve_anchors({k: v for k, v in A.items() if k != "log_dir"})[0] is None)
    check("overrides outside --sandbox are refused",
          lambda: resolve_anchors(dict(A, _sandbox_overrides={"verdicts_path": "/tmp/x"}))[0] is None)
    check("--sandbox overrides replace only the two paths, absolute only",
          lambda: resolve_anchors(dict(A, _sandbox_overrides={"verdicts_path": "/tmp/x"}), True)[0]["verdicts_path"] == "/tmp/x"
          and resolve_anchors(dict(A, _sandbox_overrides={"slot_date": "/x"}), True)[0] is None
          and resolve_anchors(dict(A, _sandbox_overrides={"log_dir": "rel"}), True)[0] is None)
    v, m = ev(rec())
    check("PASS: PUBLISHED + devto HELD + the Discussion URL, after the install",
          lambda: v == "PASS" and m["slot_records"] == 1 and m["records"][0]["class"] == "pass")
    check("other slot dates never count (the 2026-11-06 hold is ignored)", lambda: m["records"][0]["verdict"] == "PUBLISHED")
    check("FAIL: PUBLISHED + HELD with no Discussion URL", lambda: ev(rec(url=None))[0] == "FAIL")
    check("FAIL: PUBLISHED + HELD with a URL that is not the pinned repo's Discussion",
          lambda: ev(rec(url="https://github.com/AlgoVaultLabs/other/discussions/3"))[0] == "FAIL"
          and ev(rec(url="http://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/discussions/3"))[0] == "FAIL")
    check("INDETERMINATE: dev.to published (no hold in force — the scoped path was not exercised)",
          lambda: ev(rec(devto="PUBLISHED", url=None))[0] == "INDETERMINATE")
    check("INDETERMINATE: a legacy-shaped PUBLISHED with no devto field",
          lambda: ev(rec(devto=None, url=None))[0] == "INDETERMINATE")
    check("INDETERMINATE: a router G15 skip under no hold (G15_FAIL) is not the scoped path",
          lambda: ev(rec(devto="G15_FAIL"))[0] == "INDETERMINATE")
    for verdict in ("REVIEW_PENDING", "PUBLISH_FAILED", "GATE_RED", "LIVEDATA_FAILED"):
        check("INDETERMINATE: %s under devto HELD (a manual run may still publish)" % verdict,
              lambda verdict=verdict: ev(rec(verdict=verdict, url=None))[0] == "INDETERMINATE")
    check("INDETERMINATE: no record for the slot yet", lambda: ev()[0] == "INDETERMINATE" and "no record" in ev()[1]["reason"])
    check("a record written before the install is ignored, never a PASS",
          lambda: ev(rec(at="2026-11-06T13:04:26.000Z"))[0] == "INDETERMINATE"
          and ev(rec(at="2026-11-06T13:04:26.000Z"))[1]["pre_install_ignored"] == 1)
    check("FAIL: OPERATOR_HOLD while the day's log names only dev.to-scoped holds",
          lambda: ev(rec(verdict="OPERATOR_HOLD", devto=None, url=None), holds=[DEVTO_HOLD])[0] == "FAIL")
    check("INDETERMINATE: OPERATOR_HOLD under an `all` hold beside the window (the env kill switch)",
          lambda: ev(rec(verdict="OPERATOR_HOLD", devto=None, url=None), holds=[ENV_HOLD])[0] == "INDETERMINATE")
    check("INDETERMINATE: OPERATOR_HOLD and no log line names the hold",
          lambda: ev(rec(verdict="OPERATOR_HOLD", devto=None, url=None))[0] == "INDETERMINATE")
    check("INDETERMINATE: OPERATOR_HOLD and the logs are unreadable",
          lambda: ev(rec(verdict="OPERATOR_HOLD", devto=None, url=None), holds=[DEVTO_HOLD], log_err="boom")[0] == "INDETERMINATE")
    check("INDETERMINATE: OPERATOR_HOLD under a hold line with no scope (pre-wave cadence-check)",
          lambda: ev(rec(verdict="OPERATOR_HOLD", devto=None, url=None),
                     holds=[DEVTO_HOLD.replace(" scope=devto", "")])[0] == "INDETERMINATE")
    check("an unreadable log never matters without an OPERATOR_HOLD record", lambda: ev(rec(), log_err="boom")[0] == "PASS")
    check("PASS wins: a held scheduled run, then a manual run that published the slot",
          lambda: ev(rec(verdict="OPERATOR_HOLD", devto=None, url=None), rec(scheduled=False), holds=[DEVTO_HOLD])[0] == "PASS")
    check("a malformed line with no PASS is INDETERMINATE, never FAIL",
          lambda: ev(rec(url=None), "{not json")[0] == "INDETERMINATE")
    check("a malformed line does not undo a PASS", lambda: ev(rec(), "{not json")[0] == "PASS")
    check("a slot record whose `at` cannot be read is a malformed line", lambda: ev(rec(at="yesterday"))[1]["bad_lines"] == 1)
    check("an empty or unreadable ledger is INDETERMINATE",
          lambda: evaluate(A, NOW, "", None, [], None)[0] == "INDETERMINATE"
          and evaluate(A, NOW, None, "ledger unreadable", [], None)[0] == "INDETERMINATE")
    check("parse_holds reads every hold of a joined HOLD_LINES", lambda: parse_holds([ENV_HOLD]) == [
        {"source": "env", "scope": "all"}, {"source": "window", "scope": "devto"}])
    many = [rec(verdict="REVIEW_PENDING", url=None, slug="x" * 300) for _ in range(40)]
    vb, mb = ev(*many)
    check("metrics stay within the runner's 4 KiB at many records",
          lambda: vb == "INDETERMINATE" and len(json.dumps(fit_metrics(mb), sort_keys=True, separators=(",", ":")).encode()) <= METRICS_MAX_BYTES)
    out = emit(v, m)
    check("emit: METRICS then the token, exactly two lines",
          lambda: len(out) == 2 and out[0].startswith("OWED_READ_METRICS={") and out[1] == "OWED_READ_VERDICT=PASS")

    # End to end through the real IO: a temp ledger and log dir, reached only via --sandbox overrides.
    with tempfile.TemporaryDirectory() as d:
        ledger = os.path.join(d, "run-verdicts.jsonl")
        logs = os.path.join(d, "logs")
        os.mkdir(logs)
        with open(ledger, "w") as f:
            f.write(OLD + "\n" + rec(verdict="OPERATOR_HOLD", devto=None, url=None) + "\n")
        with open(os.path.join(logs, "run-20261109T020000Z.log"), "w") as f:
            f.write("[x] start\n" + DEVTO_HOLD + "\n")
        with open(os.path.join(logs, "run-20261108T020000Z.log"), "w") as f:
            f.write(ENV_HOLD + "\n")   # another day's log must not be read
        sb = dict(A, _sandbox_overrides={"verdicts_path": ledger, "log_dir": logs})
        vr, mr = run_kept(NOW, sb, sandbox=True)
        check("end to end (--sandbox): only that day's log is read; OPERATOR_HOLD under the window alone is FAIL",
              lambda: vr == "FAIL" and mr.get("sandbox") is True and mr["holds"] == [{"source": "window", "scope": "devto"}])
        with open(ledger, "a") as f:
            f.write(rec(scheduled=False) + "\n")
        check("end to end (--sandbox): a later published record turns it PASS", lambda: run_kept(NOW, sb, sandbox=True)[0] == "PASS")
        check("end to end: the same overrides without --sandbox are refused", lambda: run_kept(NOW, sb)[0] == "INDETERMINATE")
        check("end to end: a missing ledger is INDETERMINATE",
              lambda: run_kept(NOW, dict(A, _sandbox_overrides={"verdicts_path": ledger + ".gone", "log_dir": logs}), sandbox=True)[0] == "INDETERMINATE")

    check("no metrics this read emitted use a runner-owned key (the runner would make any verdict INDETERMINATE)",
          lambda: len(emitted) >= 30 and not [k for m_ in emitted for k in m_ if k in RUNNER_RESERVED_METRIC_KEYS])
    check("the reserved-key mirror equals RESERVED_METRIC_KEYS in the owed-read-runner.py beside this read",
          lambda: runner_reserved_keys() == RUNNER_RESERVED_METRIC_KEYS)

    print("self-test: %d checks, %d failed" % (len(ran), len(failures)))
    if len(ran) < _SELF_TEST_MIN_CHECKS:
        print("self-test: FAIL — only %d checks ran (floor %d)" % (len(ran), _SELF_TEST_MIN_CHECKS))
        return 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""owed-read-autopub-fulltext-home-first-run.py — OPS-AUTOPUB-FULLTEXT-HOME-W1 R5. Did the first post that dev.to did
not publish reach GitHub IN FULL, with Medium sending nothing?

Owner wave: OPS-AUTOPUB-FULLTEXT-HOME-W1. Its editorial change (algovault-editorial 55e102c, GHA deploy run
42247575275) gives a post's full text one public home:
- dev.to published it → the GitHub Discussion is a teaser pointing at dev.to.
- dev.to did not → the Discussion carries the FULL post. The run record says so: `github_body: FULL`.
- The Medium runbook leg is off unless EDITORIAL_MEDIUM_RUNBOOK=1, so no runbook state is written for the post.
R1 lives in lib/ (deployed by that run); R2-R4 live in /usr/local/bin/editorial-publish.sh, a hand-installed copy.
DEPLOY_AT is the deploy, as the spec words it. A record judged before the copy was installed lacks github_body and
FAILs, which is the truth: that run did not carry the wave.

This read finds, in the editorial run-verdict ledger, the FIRST record written at/after DEPLOY_AT that SERVED a slot
(verdict PUBLISHED) while its dev.to leg did not publish (`devto` ≠ PUBLISHED; a record with no `devto` field reads
PUBLISHED = dev.to published, as lib/run_verdicts.mjs devtoLeg() does). It prints

    OWED_READ_METRICS=<json object, <= 4 KiB>
    OWED_READ_VERDICT=PASS|FAIL|INDETERMINATE

  PASS          That record carries a github_discussion_url at github.com/AlgoVaultLabs/crypto-quant-signal-mcp/
                discussions/<n> AND github_body FULL, and medium-runbook-state.json has no entry for its slug.
  FAIL          That record misses any one of the three: no such URL, github_body not FULL (TEASER, UNKNOWN or absent),
                or a Medium runbook entry for its slug.
  INDETERMINATE Everything else, retried every tick until expires_at:
                  - No such record yet. Records that served nothing (NOT_A_RUN_DAY, OPERATOR_HOLD, REVIEW_PENDING,
                    PUBLISH_FAILED, …) and records dev.to published are not the case under test; they are counted.
                  - A malformed ledger line after the deploy and before that record (it may be the first one).
                  - URL and body pass, but the Medium state is unreadable or malformed, or the record names no slug.
                  - An unreadable ledger, or anchors that are not this read's.

Spec correction (recorded in the wave's evidence): the spec's literal "first run record after the deploy whose devto
≠ PUBLISHED" includes a NOT_A_RUN_DAY record, which carries `devto: HELD` under the escalation window and no
Discussion; judging it would FAIL on Saturday before any post exists. Only a SERVED record (PUBLISHED) is judged.

Read-only: the ledger and the Medium state file. Stdlib only; Python >= 3.9.

    owed-read-autopub-fulltext-home-first-run.py --run --now EPOCH [--sandbox] < anchors.json   (the runner)
    owed-read-autopub-fulltext-home-first-run.py --self-test
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
DEPLOY_AT = 1793980570            # 2026-11-06T15:56:10Z: GHA "Deploy to Hetzner" run 42247575275 (55e102c) completed
VERDICTS_PATH = "/var/lib/algovault-editorial/run-verdicts.jsonl"
MEDIUM_STATE_PATH = "/var/lib/algovault-editorial/medium-runbook-state.json"
ANCHORS = {"deploy_at": DEPLOY_AT, "verdicts_path": VERDICTS_PATH, "medium_state_path": MEDIUM_STATE_PATH}
SANDBOX_KEY = "_sandbox_overrides"
SANDBOX_PATH_KEYS = ("verdicts_path", "medium_state_path")   # the only keys a --sandbox override may replace
# Pinned to lib/github_discussions.mjs REPO_OWNER / REPO_NAME in algovault-editorial.
DISCUSSION_URL_RE = re.compile(r"^https://github\.com/AlgoVaultLabs/crypto-quant-signal-mcp/discussions/[1-9][0-9]*$")
ISO_AT_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z$")
FULL = "FULL"                     # lib/github_discussions.mjs DISCUSSION_BODY_MODES[0]

VERDICTS = ("PASS", "FAIL", "INDETERMINATE")
EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
# owed-read-runner.py RESERVED_METRIC_KEYS: the runner turns any read whose metrics use one into INDETERMINATE,
# whatever its token says. The self-test asserts no metrics this read emits use one, and that this mirror equals the
# runner beside it.
RUNNER_RESERVED_METRIC_KEYS = ("read_id", "wave", "not_before", "expires_at", "attempt", "expired", "script",
                               "duration_s", "runner_reason")
METRICS_MAX_BYTES = 4096
SAMPLE_MAX = 8
STATE_MAX_BYTES = 8 * 1024 * 1024


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
    --sandbox, `_sandbox_overrides` may replace only the two paths, so fixtures can stand in for the host files."""
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

def devto_leg(r):
    """lib/run_verdicts.mjs devtoLeg(): the recorded field wins; a legacy PUBLISHED means dev.to published."""
    d = r.get("devto")
    if isinstance(d, str):
        return d
    if r.get("verdict") == "PUBLISHED":
        return "PUBLISHED"
    if r.get("verdict") == "OPERATOR_HOLD":
        return "HELD"
    return None


def is_candidate(r):
    """A record of the case under test: it served the slot while dev.to did not publish the post."""
    return r.get("verdict") == "PUBLISHED" and devto_leg(r) != "PUBLISHED"


def scan_ledger(text, deploy_at):
    """-> dict: the first candidate written at/after the deploy (with its line number), the malformed lines that
    could precede it, and counts. Lines are appended in time order, so file order is time order."""
    first, first_line = None, None
    bad, pre, post, n, skipped = [], 0, 0, 0, {}
    last_pre_line = 0
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
        at = iso_epoch(r.get("at"))
        if at is None:
            bad.append(i)
            continue
        if at < deploy_at:
            pre += 1
            last_pre_line = i
            continue
        post += 1
        if first is not None:
            continue
        if is_candidate(r):
            first, first_line = r, i
        else:
            key = "%s/devto=%s" % (r.get("verdict"), devto_leg(r) or "-")
            skipped[key] = skipped.get(key, 0) + 1
    # A malformed line between the last pre-deploy record and the candidate (or the file's end) may itself be the
    # first candidate, so it blocks a verdict; one before the deploy never can.
    stop = first_line if first_line is not None else float("inf")
    blocking = [b for b in bad if last_pre_line < b < stop]
    return {"first": first, "first_line": first_line, "bad": bad, "blocking_bad": blocking, "pre": pre,
            "post": post, "lines": n, "skipped": skipped}


def medium_entry(state_text, state_err, slug):
    """-> (True | False | None, reason). True = the Medium state names the slug; None = cannot tell."""
    if state_err == "missing":
        return False, "no medium-runbook-state.json (no runbook was ever built)"
    if state_err:
        return None, state_err
    try:
        s = json.loads(state_text)
    except ValueError:
        return None, "medium-runbook-state.json is not valid JSON"
    posts = s.get("posts") if isinstance(s, dict) else None
    if not isinstance(posts, dict):
        return None, "medium-runbook-state.json has no `posts` object"
    return (slug in posts), ("a Medium runbook entry exists for %s" % slug if slug in posts else "no Medium entry")


def summarize(r):
    return {"verdict": r.get("verdict"), "devto": r.get("devto"), "url": r.get("github_discussion_url"),
            "github_body": r.get("github_body"), "slug": r.get("slug"), "scheduled": r.get("scheduled"),
            "catch_up": r.get("catch_up"), "at": r.get("at")}


def evaluate(anchors, now, ledger, ledger_err, state_text, state_err, sandbox=False):
    """-> (verdict, metrics). The single derivation of the verdict."""
    a, why = resolve_anchors(anchors, sandbox)
    if why:
        return "INDETERMINATE", {"reason": why}
    if ledger_err:
        return "INDETERMINATE", {"reason": ledger_err}
    s = scan_ledger(ledger, a["deploy_at"])
    m = {"deploy_at": utc_iso(a["deploy_at"]), "now": utc_iso(now), "ledger_lines": s["lines"],
         "pre_deploy_ignored": s["pre"], "post_deploy_records": s["post"], "bad_lines": len(s["bad"]),
         "blocking_bad_line_sample": s["blocking_bad"][:SAMPLE_MAX], "not_the_case_under_test": s["skipped"]}
    if not s["lines"]:
        return "INDETERMINATE", dict(m, reason="the ledger holds no record at all (an empty or truncated file)")
    if s["blocking_bad"]:
        return "INDETERMINATE", dict(m, reason="%d malformed post-deploy ledger line(s) before any judged record — "
                                               "the first one may be among them" % len(s["blocking_bad"]))
    r = s["first"]
    if r is None:
        return "INDETERMINATE", dict(m, reason="no record since the deploy served a slot that dev.to did not publish")
    m["record"] = summarize(r)
    m["record_line"] = s["first_line"]
    url, body, slug = r.get("github_discussion_url"), r.get("github_body"), r.get("slug")
    parts = {"discussion_url": bool(isinstance(url, str) and DISCUSSION_URL_RE.match(url)),
             "github_body_full": body == FULL}
    m["parts"] = parts
    if not all(parts.values()):
        missing = [k for k, ok in parts.items() if not ok]
        return "FAIL", dict(m, reason="the first post dev.to did not publish fails: %s" % ", ".join(missing))
    if not (isinstance(slug, str) and slug):
        return "INDETERMINATE", dict(m, reason="the record names no slug, so the Medium state cannot be checked")
    has, why = medium_entry(state_text, state_err, slug)
    parts["no_medium_entry"] = None if has is None else (not has)
    if has is None:
        return "INDETERMINATE", dict(m, reason="URL and body pass; the Medium state cannot be read: " + why)
    if has:
        return "FAIL", dict(m, reason=why + " — the Medium leg ran")
    return "PASS", dict(m, reason="full post on GitHub, no Medium runbook")


def fit_metrics(m):
    """The runner's 4 KiB budget: drop the record URL, then the samples."""
    def size(x):
        return len(json.dumps(x, sort_keys=True, separators=(",", ":")).encode())
    if size(m) <= METRICS_MAX_BYTES:
        return m
    m = json.loads(json.dumps(m))
    if isinstance(m.get("record"), dict):
        m["record"].pop("url", None)
    m["_trimmed"] = "record url dropped to fit 4 KiB"
    if size(m) <= METRICS_MAX_BYTES:
        return m
    m.pop("blocking_bad_line_sample", None)
    skipped = m.get("not_the_case_under_test") or {}
    m["not_the_case_under_test"] = dict(sorted(skipped.items(), key=lambda kv: -kv[1])[:4])
    m["_trimmed"] += "; samples cut"
    return m


# ── IO (read-only) ───────────────────────────────────────────────────────────────────────────

def read_ledger(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(), None
    except OSError as e:
        return None, "ledger %s unreadable: %s" % (path, type(e).__name__)


def read_state(path):
    """-> (text, None) | (None, 'missing') | (None, reason)."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(STATE_MAX_BYTES), None
    except FileNotFoundError:
        return None, "missing"
    except OSError as e:
        return None, "medium state %s unreadable: %s" % (path, type(e).__name__)


def run(now, anchors, sandbox=False):
    a, why = resolve_anchors(anchors, sandbox)
    if why:
        return "INDETERMINATE", {"reason": why}
    ledger, ledger_err = read_ledger(a["verdicts_path"])
    state_text, state_err = read_state(a["medium_state_path"])
    verdict, metrics = evaluate(anchors, now, ledger, ledger_err, state_text, state_err, sandbox)
    if sandbox:
        metrics["sandbox"] = True
    return verdict, fit_metrics(metrics)


def emit(verdict, metrics):
    """The two contract lines, the token last."""
    return ["OWED_READ_METRICS=" + json.dumps(metrics, sort_keys=True, separators=(",", ":")),
            "OWED_READ_VERDICT=" + verdict]


def main(argv=None):
    ap = argparse.ArgumentParser(description="owed read: autopub-fulltext-home-first-run")
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

_SELF_TEST_MIN_CHECKS = 40


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
    NOW = DEPLOY_AT + 3 * 86400
    URL = "https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/discussions/81"
    AFTER = utc_iso(DEPLOY_AT + 2 * 86400).replace("Z", ".120Z")
    BEFORE = utc_iso(DEPLOY_AT - 1).replace("Z", ".000Z")

    def rec(verdict="PUBLISHED", devto="HELD", url=URL, body="FULL", slug="a-post", at=None, **kw):
        r = {"slot_date": "2026-11-09", "verdict": verdict, "catch_up": False, "scheduled": True, "run_day": True,
             "run_days": "Mon,Wed,Fri", "slug": slug, "rc": 0}
        if devto is not None:
            r["devto"] = devto
        if url is not None:
            r["github_discussion_url"] = url
        if body is not None:
            r["github_body"] = body
        r["at"] = AFTER if at is None else at
        r.update(kw)
        return json.dumps(r)

    # Pre-deploy history in every ledger: the 2026-11-04 dev.to publish and the 2026-11-06 hold (real shapes).
    OLD = (rec(devto=None, url=None, body=None, slot_date="2026-11-04", at="2026-11-04T06:21:54.342Z", slug="old"),
           rec(verdict="OPERATOR_HOLD", devto=None, url=None, body=None, slot_date="2026-11-06",
               at="2026-11-06T02:00:00.551Z", run_day=False, slug=None))
    NO_MEDIUM = json.dumps({"posts": {"old": {"runbookPath": "/x", "hashnodeUrl": "https://dev.to/x"}}})
    WITH_MEDIUM = json.dumps({"posts": {"old": {}, "a-post": {"runbookPath": "/y", "hashnodeUrl": None}}})

    emitted = []   # every metrics object a scenario produced — none may use a runner-owned key

    def ev(*lines, state=NO_MEDIUM, state_err=None, ledger_err=None, anchors=None, sandbox=False, old=True):
        text = "\n".join((OLD if old else ()) + lines) + "\n"
        v_, m_ = evaluate(A if anchors is None else anchors, NOW, text, ledger_err, state, state_err, sandbox)
        emitted.append(m_)
        return v_, m_

    def run_kept(*args, **kw):
        v_, m_ = run(*args, **kw)
        emitted.append(m_)
        return v_, m_

    SAT = rec(verdict="NOT_A_RUN_DAY", devto="HELD", url=None, body=None, slug=None, run_day=False)

    check("contract constants: exit codes 0/1/3; the paths are the editorial state dir's",
          lambda: EXIT_FOR == {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
          and VERDICTS_PATH == "/var/lib/algovault-editorial/run-verdicts.jsonl"
          and MEDIUM_STATE_PATH == "/var/lib/algovault-editorial/medium-runbook-state.json")
    check("the Discussion URL is pinned to AlgoVaultLabs/crypto-quant-signal-mcp's discussions",
          lambda: DISCUSSION_URL_RE.match(URL) and not DISCUSSION_URL_RE.match(URL.replace("https:", "http:"))
          and not DISCUSSION_URL_RE.match(URL.replace("crypto-quant-signal-mcp", "other-repo"))
          and not DISCUSSION_URL_RE.match(URL + "#x") and not DISCUSSION_URL_RE.match(URL[:-2] + "0"))
    check("anchors equal to the pre-registration resolve", lambda: resolve_anchors(dict(A)) == (A, None))
    check("a retuned deploy_at (or one as a string) is INDETERMINATE",
          lambda: ev(rec(), anchors=dict(A, deploy_at=DEPLOY_AT - 1))[0] == "INDETERMINATE"
          and resolve_anchors(dict(A, deploy_at=str(DEPLOY_AT)))[0] is None)
    check("an extra or a missing anchor key is INDETERMINATE",
          lambda: resolve_anchors(dict(A, extra=1))[0] is None
          and resolve_anchors({k: v for k, v in A.items() if k != "medium_state_path"})[0] is None)
    check("overrides outside --sandbox are refused",
          lambda: resolve_anchors(dict(A, _sandbox_overrides={"verdicts_path": "/tmp/x"}))[0] is None)
    check("--sandbox overrides replace only the two paths, absolute only",
          lambda: resolve_anchors(dict(A, _sandbox_overrides={"medium_state_path": "/tmp/m"}), True)[0]["medium_state_path"] == "/tmp/m"
          and resolve_anchors(dict(A, _sandbox_overrides={"deploy_at": "/x"}), True)[0] is None
          and resolve_anchors(dict(A, _sandbox_overrides={"verdicts_path": "rel"}), True)[0] is None)

    v, m = ev(rec())
    check("PASS: PUBLISHED, devto HELD, the Discussion URL, github_body FULL, no Medium entry",
          lambda: v == "PASS" and m["record"]["github_body"] == "FULL" and m["parts"] == {
              "discussion_url": True, "github_body_full": True, "no_medium_entry": True})
    check("pre-deploy history never counts (the 11-04 dev.to publish, the 11-06 hold)",
          lambda: m["pre_deploy_ignored"] == 2 and m["post_deploy_records"] == 1)
    for d in ("G15_FAIL", "G15_INDETERMINATE", "REFUSED", "INDETERMINATE", "FAILED"):
        check("PASS also under devto %s (dev.to did not publish, the post went out on GitHub)" % d,
              lambda d=d: ev(rec(devto=d))[0] == "PASS")
    check("FAIL: github_body TEASER", lambda: ev(rec(body="TEASER"))[0] == "FAIL")
    check("FAIL: github_body UNKNOWN (a pre-wave Discussion on the dedup path)", lambda: ev(rec(body="UNKNOWN"))[0] == "FAIL")
    check("FAIL: no github_body at all (an orchestrator from before the install)", lambda: ev(rec(body=None))[0] == "FAIL")
    check("FAIL: no Discussion URL", lambda: ev(rec(url=None))[0] == "FAIL")
    check("FAIL: a URL that is not the pinned repo's Discussion",
          lambda: ev(rec(url="https://github.com/AlgoVaultLabs/other/discussions/3"))[0] == "FAIL"
          and ev(rec(url="http://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/discussions/3"))[0] == "FAIL")
    check("FAIL: a Medium runbook entry for the slug (the Medium leg ran)",
          lambda: ev(rec(), state=WITH_MEDIUM)[0] == "FAIL" and "Medium" in ev(rec(), state=WITH_MEDIUM)[1]["reason"])
    check("FAIL beats an unreadable Medium state when the body already failed",
          lambda: ev(rec(body="TEASER"), state=None, state_err="unreadable: PermissionError")[0] == "FAIL")
    check("PASS: no medium-runbook-state.json at all means no runbook was built",
          lambda: ev(rec(), state=None, state_err="missing")[0] == "PASS")
    check("INDETERMINATE: URL + body pass, Medium state unreadable",
          lambda: ev(rec(), state=None, state_err="medium state x unreadable: PermissionError")[0] == "INDETERMINATE")
    check("INDETERMINATE: URL + body pass, Medium state not JSON / no posts object",
          lambda: ev(rec(), state="{oops")[0] == "INDETERMINATE" and ev(rec(), state="[]")[0] == "INDETERMINATE"
          and ev(rec(), state='{"posts": []}')[0] == "INDETERMINATE")
    check("INDETERMINATE: URL + body pass, the record names no slug", lambda: ev(rec(slug=None))[0] == "INDETERMINATE")
    check("the spec correction: Saturday's NOT_A_RUN_DAY (devto HELD, no Discussion) is not judged",
          lambda: ev(SAT)[0] == "INDETERMINATE" and ev(SAT)[1]["not_the_case_under_test"] == {"NOT_A_RUN_DAY/devto=HELD": 1})
    check("…and the first SERVED record after it is", lambda: ev(SAT, rec())[0] == "PASS" and ev(SAT, rec(body="TEASER"))[0] == "FAIL")
    for verdict in ("REVIEW_PENDING", "PUBLISH_FAILED", "OPERATOR_HOLD", "GATE_RED"):
        check("INDETERMINATE: %s served nothing (not the case under test)" % verdict,
              lambda verdict=verdict: ev(rec(verdict=verdict, url=None, body=None))[0] == "INDETERMINATE")
    check("INDETERMINATE: dev.to published (devto PUBLISHED, or a legacy record with no devto field)",
          lambda: ev(rec(devto="PUBLISHED", body="TEASER"))[0] == "INDETERMINATE"
          and ev(rec(devto=None, body=None))[0] == "INDETERMINATE")
    check("only the FIRST candidate is judged: a later FULL never rescues an earlier TEASER",
          lambda: ev(rec(body="TEASER"), rec(slug="b"))[0] == "FAIL")
    check("…and a later TEASER never undoes an earlier PASS", lambda: ev(rec(), rec(body="TEASER", slug="b"))[0] == "PASS")
    check("a dev.to-published record before it does not count as the first",
          lambda: ev(rec(devto="PUBLISHED", body="TEASER", slug="dev"), rec())[0] == "PASS")
    check("a record written just before the deploy is ignored, never judged",
          lambda: ev(rec(body="TEASER", at=BEFORE))[0] == "INDETERMINATE" and ev(rec(body="TEASER", at=BEFORE))[1]["pre_deploy_ignored"] == 3)
    check("INDETERMINATE: a malformed post-deploy line before any candidate (it may be the first)",
          lambda: ev("{not json", rec())[0] == "INDETERMINATE" and ev(rec(at="yesterday"), rec())[0] == "INDETERMINATE")
    check("a malformed line AFTER the judged record does not block it", lambda: ev(rec(), "{not json")[0] == "PASS")
    check("a malformed line before the deploy (between pre-deploy records) does not block",
          lambda: ev(old=False, *("{bad", OLD[0], OLD[1], rec()))[0] == "PASS")
    check("an empty or unreadable ledger is INDETERMINATE",
          lambda: evaluate(A, NOW, "", None, NO_MEDIUM, None)[0] == "INDETERMINATE"
          and evaluate(A, NOW, None, "ledger unreadable", NO_MEDIUM, None)[0] == "INDETERMINATE")
    check("INDETERMINATE: no candidate yet (only pre-deploy history)", lambda: ev()[0] == "INDETERMINATE")
    many = [rec(verdict="REVIEW_PENDING", url=None, body=None, slug="x" * 300, run_days="r%d" % i) for i in range(40)]
    vb, mb = ev(*many)
    check("metrics stay within the runner's 4 KiB at many records",
          lambda: vb == "INDETERMINATE" and len(json.dumps(fit_metrics(mb), sort_keys=True, separators=(",", ":")).encode()) <= METRICS_MAX_BYTES)
    vl, ml = ev(rec(url=URL + "/x" * 2500))
    check("a huge record still fits 4 KiB (the URL is dropped first) and keeps its verdict",
          lambda: vl == "FAIL" and len(json.dumps(ml, sort_keys=True, separators=(",", ":")).encode()) > METRICS_MAX_BYTES
          and len(json.dumps(fit_metrics(ml), sort_keys=True, separators=(",", ":")).encode()) <= METRICS_MAX_BYTES
          and "url" not in fit_metrics(ml)["record"] and fit_metrics(ml)["record"]["github_body"] == "FULL")
    out = emit(v, m)
    check("emit: METRICS then the token, exactly two lines",
          lambda: len(out) == 2 and out[0].startswith("OWED_READ_METRICS={") and out[1] == "OWED_READ_VERDICT=PASS")

    # End to end through the real IO: a temp ledger and state file, reached only via --sandbox overrides.
    with tempfile.TemporaryDirectory() as d:
        ledger = os.path.join(d, "run-verdicts.jsonl")
        state = os.path.join(d, "medium-runbook-state.json")
        with open(ledger, "w") as f:
            f.write("\n".join(OLD + (SAT,)) + "\n")
        with open(state, "w") as f:
            f.write(NO_MEDIUM)
        sb = dict(A, _sandbox_overrides={"verdicts_path": ledger, "medium_state_path": state})
        vr, mr = run_kept(NOW, sb, sandbox=True)
        check("end to end (--sandbox): only Saturday's NOT_A_RUN_DAY so far → INDETERMINATE",
              lambda: vr == "INDETERMINATE" and mr.get("sandbox") is True)
        with open(ledger, "a") as f:
            f.write(rec() + "\n")
        check("end to end (--sandbox): Monday's FULL publish → PASS", lambda: run_kept(NOW, sb, sandbox=True)[0] == "PASS")
        with open(state, "w") as f:
            f.write(WITH_MEDIUM)
        check("end to end (--sandbox): a Medium entry for the slug → FAIL", lambda: run_kept(NOW, sb, sandbox=True)[0] == "FAIL")
        os.remove(state)
        check("end to end (--sandbox): no state file → PASS", lambda: run_kept(NOW, sb, sandbox=True)[0] == "PASS")
        check("end to end: the same overrides without --sandbox are refused", lambda: run_kept(NOW, sb)[0] == "INDETERMINATE")
        check("end to end: a missing ledger is INDETERMINATE",
              lambda: run_kept(NOW, dict(A, _sandbox_overrides={"verdicts_path": ledger + ".gone", "medium_state_path": state}), sandbox=True)[0] == "INDETERMINATE")

    check("no metrics this read emitted use a runner-owned key (the runner would make any verdict INDETERMINATE)",
          lambda: len(emitted) >= 40 and not [k for m_ in emitted for k in m_ if k in RUNNER_RESERVED_METRIC_KEYS])
    check("the reserved-key mirror equals RESERVED_METRIC_KEYS in the owed-read-runner.py beside this read",
          lambda: runner_reserved_keys() == RUNNER_RESERVED_METRIC_KEYS)

    print("self-test: %d checks, %d failed" % (len(ran), len(failures)))
    if len(ran) < _SELF_TEST_MIN_CHECKS:
        print("self-test: FAIL — only %d checks ran (floor %d)" % (len(ran), _SELF_TEST_MIN_CHECKS))
        return 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

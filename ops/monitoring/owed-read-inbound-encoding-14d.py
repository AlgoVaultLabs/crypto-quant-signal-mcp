#!/usr/bin/env python3
"""owed-read-inbound-encoding-14d.py — OPS-NODE-SECURITY-FLOOR-W1 CH2 R3. The second owed read.

Owner wave: OPS-NODE-SECURITY-FLOOR-W1. Its CH2 R2 answers 415 to a request body in `br` (or in any
coding outside identity / gzip / deflate). R-FLIP would refuse every non-identity coding — but only
if nothing that works today sends gzip or deflate bodies to api.algovault.com. CH2 R3 installed a
Caddy access log on that vhost that writes ONLY requests carrying a Content-Encoding header
(/var/log/caddy/api-encoded-requests.log: client IP masked at write time, query string and path
tokens dropped, credential headers deleted). owed-read-runner.py runs this script when the registry
row is due, 14 days after that install; it answers ONE question and prints

    OWED_READ_METRICS=<json object, <= 4 KiB>
    OWED_READ_VERDICT=PASS|FAIL|INDETERMINATE

── THE RULE (pre-registered in the wave's spec, CH2 R3 — this file implements it, never retunes it) ──
  A SENDER is a (route, client /24) pair with >= 3 requests labelled gzip or deflate that were
  answered 2xx, on >= 2 distinct UTC days. PASS = no sender. FAIL = the senders, each listed with its
  User-Agent families.

  The words of the rule, fixed here:
    labelled gzip/deflate  every coding the Content-Encoding header lists is gzip, deflate or
                           identity, and at least one is gzip or deflate — exactly the requests
                           R-FLIP would newly refuse (any other coding is refused already). No body
                           is required: the log cannot see a chunked or HTTP/2 body that has no
                           Content-Length, so a bodiless request counts (towards FAIL) and is
                           reported.
    route                  method + path, lower-cased, query dropped; every segment after the
                           second becomes `*`, so an id or a token never splits one client into
                           many routes.
    client /24             Cf-Connecting-Ip (the vhost is behind Cloudflare), else remote_ip,
                           re-masked here to /24 (IPv4) or /48 (IPv6, the log's own mask).
    UA family              the User-Agent's first product token, lower-cased.

── LEGS ────────────────────────────────────────────────────────────────────────────────────────
  senders   the rule, over every line of the rotation chain written in [install_at, now).
  coverage  the chain is read NEWEST FIRST, each file whole, back to the file holding the install's
            positive-control line (User-Agent `control_ua`, within 10 min of install_at) — the first
            line the log ever wrote. A file absent, unreadable or holding an unparseable line before
            that point is a gap, and so is a line older than the install -> INDETERMINATE. A sender
            needs no coverage: it is a FAIL on its own (more lines can only add requests).
  logger    the RUNNING Caddy config (admin API on 127.0.0.1, one read-only GET) still routes the
            api.algovault.com access log to this file through the regexp URI filter, so the log
            was live at the end of the window as well as at its start.

  PASS iff all three PASS. FAIL iff senders FAIL. Else INDETERMINATE.

A rotation removed by hand from the MIDDLE of the chain is not detectable in a log that is sparse by
design; lumberjack prunes oldest-first (roll_keep 10, roll_keep_for 720h), which the control line
detects.

    owed-read-inbound-encoding-14d.py --run --now EPOCH [--sandbox] < anchors.json   (the runner)
    owed-read-inbound-encoding-14d.py --self-test
"""
from __future__ import annotations

import argparse
import glob
import gzip
import ipaddress
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# ── the pre-registration (the wave's spec, CH2 R3; the install is recorded in its status entry) ──
WAVE = "OPS-NODE-SECURITY-FLOOR-W1"
INSTALL_AT = 1792860425                # 2026-10-24T16:47:05Z, the `systemctl reload caddy` that installed the log
CONTROL_UA = "algovault-nsf-w1-control/97e20b4c"   # the install's positive-control gzip POST
LOG_PATH = "/var/log/caddy/api-encoded-requests.log"
API_HOST = "api.algovault.com"
MIN_REQUESTS = 3
MIN_DAYS = 2
STATUS_RANGE = [200, 299]
CODINGS = ["deflate", "gzip"]          # what R-FLIP would newly refuse
PREFIX_V4, PREFIX_V6 = 24, 48
COVERAGE_SLACK_S = 600
# What the registry row's `anchors` must equal. The registry is inert data that arrives by
# declaration-sync; a row can SELECT this read but can never retune it — a differing anchor is
# INDETERMINATE, and the fix is a reviewed edit of this file.
ANCHORS = {"install_at": INSTALL_AT, "log": LOG_PATH, "control_ua": CONTROL_UA, "host": API_HOST,
           "min_requests": MIN_REQUESTS, "min_days": MIN_DAYS, "status_range": STATUS_RANGE,
           "codings": CODINGS, "prefix_v4": PREFIX_V4, "prefix_v6": PREFIX_V6}
SANDBOX_KEY = "_sandbox_overrides"
# The forced-FAIL proof on the live log at install, nothing else: the control line is a 4xx.
SANDBOX_OVERRIDABLE = ("min_requests", "min_days", "status_range")

ADMIN_CONFIG_URL = "http://127.0.0.1:2019/config/"
ADMIN_TIMEOUT_S = 10
URI_FILTER = "regexp"

VERDICTS = ("PASS", "FAIL", "INDETERMINATE")
EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
METRICS_MAX_BYTES = 4096
SENDERS_LISTED = 10
UA_FAMILIES_LISTED = 3
ROUTE_MAX_CHARS = 80

_BACKUP_TS = re.compile(r"^(?P<stem>.+)-(?P<ts>\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3})(?P<ext>\.log)(?P<gz>\.gz)?$")
_UA_TOKEN = re.compile(r"[A-Za-z0-9._+-]+")


# ── the anchors the runner hands over ────────────────────────────────────────────────────────

def _override_ok(key, v):
    if key in ("min_requests", "min_days"):
        return type(v) is int and v >= 1
    if key == "status_range":
        return (isinstance(v, list) and len(v) == 2 and all(type(x) is int for x in v)
                and 100 <= v[0] <= v[1] <= 599)
    return False


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
        for k, v in overrides.items():
            if not _override_ok(k, v):
                return None, "sandbox override %s=%r is out of range" % (k, v)
            eff[k] = v
    return eff, None


# ── one log line -> the fields the rule reads ────────────────────────────────────────────────

def parse_line(line):
    """A Caddy v2.6 JSON access-log line -> (event, None) or (None, reason)."""
    try:
        o = json.loads(line)
    except ValueError:
        return None, "not JSON"
    req = o.get("request") if isinstance(o, dict) else None
    if not isinstance(req, dict):
        return None, "no request object"
    ts, status = o.get("ts"), o.get("status")
    if isinstance(ts, bool) or not isinstance(ts, (int, float)) or type(status) is not int:
        return None, "no numeric ts / int status"
    raw = req.get("headers")
    hdrs = {str(k).lower(): v for k, v in raw.items()} if isinstance(raw, dict) else {}

    def header(name):
        v = hdrs.get(name)
        if isinstance(v, list):
            return ",".join(str(x) for x in v)
        return v if isinstance(v, str) else None
    return {"ts": float(ts), "status": status, "method": str(req.get("method") or ""),
            "uri": str(req.get("uri") or ""), "ce": header("content-encoding"),
            "cl": header("content-length"), "ua": header("user-agent"),
            "cfip": header("cf-connecting-ip"), "remote_ip": str(req.get("remote_ip") or "")}, None


def codings_of(header):
    return [c.strip().lower() for c in (header or "").split(",") if c.strip()]


def labelled_gzip_deflate(header, codings=CODINGS):
    cs = codings_of(header)
    return bool(cs) and all(c in codings or c == "identity" for c in cs) and any(c in codings for c in cs)


def coding_class(header, codings=CODINGS):
    """For the report: which refusal the request falls under today."""
    if labelled_gzip_deflate(header, codings):
        return "gzip_deflate"
    cs = codings_of(header)
    if "br" in cs:
        return "br"
    if cs and all(c == "identity" for c in cs):
        return "identity"
    return "other"


def route_of(method, uri):
    path = uri.split("?", 1)[0].split("#", 1)[0].lower()
    segs = path[1:].split("/") if path.startswith("/") else [path]
    kept = segs[:2] + ["*"] * max(0, len(segs) - 2)
    return ("%s /%s" % (method.upper() or "-", "/".join(kept)))[:ROUTE_MAX_CHARS]


def prefix_of(cfip, remote_ip, v4=PREFIX_V4, v6=PREFIX_V6):
    raw = (cfip or "").split(",")[0].strip() or (remote_ip or "").strip()
    try:
        a = ipaddress.ip_address(raw)
    except ValueError:
        return None
    return str(ipaddress.ip_network("%s/%d" % (a, v4 if a.version == 4 else v6), strict=False))


def ua_family(ua):
    s = (ua or "").strip()
    if not s:
        return "(none)"
    m = _UA_TOKEN.match(s)
    return m.group(0).lower()[:40] if m else "(other)"


# ── the rotation chain ───────────────────────────────────────────────────────────────────────

def chain(log_path):
    """NEWEST FIRST: the live file, then lumberjack's backups `<stem>-<UTC ts>.log[.gz]` by their
    timestamp. A backup caught mid-compression exists twice; the complete uncompressed copy wins."""
    d, base = os.path.split(log_path)
    stem, ext = os.path.splitext(base)
    by_ts = {}
    for p in glob.glob(os.path.join(glob.escape(d), glob.escape(stem) + "-*" + ext + "*")):
        m = _BACKUP_TS.match(os.path.basename(p))
        if not m or m.group("stem") != stem or m.group("ext") != ext:
            continue
        if m.group("ts") not in by_ts or not p.endswith(".gz"):
            by_ts[m.group("ts")] = p
    return [log_path] + [by_ts[t] for t in sorted(by_ts, reverse=True)]


def read_chain(paths, eff, now):
    """Stream the chain newest-first, each file whole, until the file holding the control line.
    -> a dict of what was read; the legs judge it."""
    install_at, slack = eff["install_at"], COVERAGE_SLACK_S
    lo, hi = eff["status_range"]
    codings = eff["codings"]
    pairs, classes, gd_status = {}, {}, {}
    files, why, covered_by = [], None, None
    lines_read = bad = predates = future = unattributed = tail_tolerated = 0
    first_bad = None
    for idx, p in enumerate(paths):
        name = os.path.basename(p)
        if not os.path.exists(p):
            files.append({"file": name, "present": False})
            why = why or "rotation %s is absent before coverage reached the install's control line" % name
            continue
        n, first, control = 0, None, False
        try:
            opener = gzip.open if p.endswith(".gz") else open
            with opener(p, "rt", encoding="utf-8", errors="replace") as fh:
                pending = None
                for raw in fh:
                    if pending is not None:
                        n, first, control, b = _one(pending, False, idx, eff, now, pairs, classes, gd_status,
                                                    n, first, control)
                        bad += b[0]; predates += b[1]; future += b[2]; unattributed += b[3]
                        first_bad = first_bad or b[4]
                    pending = raw
                if pending is not None:
                    n, first, control, b = _one(pending, True, idx, eff, now, pairs, classes, gd_status,
                                                n, first, control)
                    bad += b[0]; predates += b[1]; future += b[2]; unattributed += b[3]; tail_tolerated += b[5]
                    first_bad = first_bad or b[4]
        except (OSError, EOFError, ValueError) as e:
            files.append({"file": name, "present": True, "error": type(e).__name__})
            why = why or "%s unreadable: %s" % (name, type(e).__name__)
            break
        lines_read += n
        files.append({"file": name, "present": True, "lines": n, "first": None if first is None else int(first)})
        if control:
            if why is None:
                covered_by = name
            break                                   # older files predate the install
    return {"pairs": pairs, "classes": classes, "gd_status": gd_status, "files": files, "why": why,
            "covered_by": covered_by, "lines_read": lines_read, "bad": bad, "first_bad": first_bad,
            "predates": predates, "future": future, "unattributed": unattributed,
            "tail_tolerated": tail_tolerated}


def _one(raw, is_last, file_idx, eff, now, pairs, classes, gd_status, n, first, control):
    """One line into the accumulators. -> (n, first, control, (bad, predates, future, unattributed,
    first_bad_reason, tail_tolerated))."""
    n += 1
    line = raw.strip()
    if not line:
        return n, first, control, (0, 0, 0, 0, None, 0)
    e, err = parse_line(line)
    if e is None:
        if is_last and file_idx == 0:               # the live file's last line, mid-write
            return n, first, control, (0, 0, 0, 0, None, 1)
        return n, first, control, (1, 0, 0, 0, err, 0)
    ts = e["ts"]
    if first is None:
        first = ts
    if ts < eff["install_at"] - COVERAGE_SLACK_S:
        return n, first, control, (0, 1, 0, 0, None, 0)
    if ts >= now:
        return n, first, control, (0, 0, 1, 0, None, 0)
    if e["ua"] == eff["control_ua"] and eff["install_at"] <= ts <= eff["install_at"] + COVERAGE_SLACK_S:
        control = True
    cls = coding_class(e["ce"], eff["codings"])
    classes[cls] = classes.get(cls, 0) + 1
    if cls != "gzip_deflate":
        return n, first, control, (0, 0, 0, 0, None, 0)
    sc = "%dxx" % (e["status"] // 100)
    gd_status[sc] = gd_status.get(sc, 0) + 1
    lo, hi = eff["status_range"]
    if not lo <= e["status"] <= hi:
        return n, first, control, (0, 0, 0, 0, None, 0)
    prefix = prefix_of(e["cfip"], e["remote_ip"], eff["prefix_v4"], eff["prefix_v6"])
    if prefix is None:
        return n, first, control, (0, 0, 0, 1, None, 0)
    key = (route_of(e["method"], e["uri"]), prefix)
    agg = pairs.setdefault(key, {"n": 0, "days": set(), "ua": {}, "bodyless": 0})
    agg["n"] += 1
    agg["days"].add(time.strftime("%Y-%m-%d", time.gmtime(ts)))
    fam = ua_family(e["ua"])
    agg["ua"][fam] = agg["ua"].get(fam, 0) + 1
    if not (e["cl"] or "").strip().isdigit() or int(e["cl"].strip()) == 0:
        agg["bodyless"] += 1
    return n, first, control, (0, 0, 0, 0, None, 0)


# ── the legs ─────────────────────────────────────────────────────────────────────────────────

def leg_senders(res, eff):
    found = []
    for (route, prefix), a in res["pairs"].items():
        if a["n"] >= eff["min_requests"] and len(a["days"]) >= eff["min_days"]:
            uas = sorted(a["ua"].items(), key=lambda kv: (-kv[1], kv[0]))[:UA_FAMILIES_LISTED]
            found.append({"route": route, "prefix": prefix, "requests": a["n"], "days": len(a["days"]),
                          "ua": [k for k, _ in uas], "bodyless": a["bodyless"]})
    found.sort(key=lambda s: (-s["requests"], s["route"], s["prefix"]))
    leg = {"pairs": len(res["pairs"]), "qualifying_requests": sum(a["n"] for a in res["pairs"].values()),
           "senders_total": len(found), "senders": found[:SENDERS_LISTED]}
    if found:
        leg["verdict"] = "FAIL"
    elif res["unattributed"]:
        leg.update(verdict="INDETERMINATE",
                   reason="%d qualifying request(s) carry no parseable client address" % res["unattributed"])
    else:
        leg["verdict"] = "PASS"
    return leg


def leg_coverage(res):
    leg = {"covered_by": res["covered_by"] or "-", "lines_read": res["lines_read"], "files": res["files"],
           "tail_tolerated": res["tail_tolerated"]}
    probs = []
    if res["covered_by"] is None:
        probs.append(res["why"] or "no file in the chain holds the install's control line")
    if res["bad"]:
        probs.append("%d unparseable line(s), first: %s" % (res["bad"], res["first_bad"]))
    if res["predates"]:
        probs.append("%d line(s) older than the install — this is not the file the install created"
                     % res["predates"])
    if probs:
        leg.update(verdict="INDETERMINATE", reason="coverage: " + "; ".join(probs)[:300])
    else:
        leg["verdict"] = "PASS"
    return leg


def leg_logger(cfg, cfg_err, log_path, host):
    if cfg is None:
        return {"verdict": "INDETERMINATE", "reason": cfg_err or "no running config"}
    try:
        servers, logs = cfg["apps"]["http"]["servers"], cfg["logging"]["logs"]
        names = []
        for srv in servers.values():
            v = ((srv or {}).get("logs") or {}).get("logger_names", {}).get(host)
            names += v if isinstance(v, list) else [v] if v else []
    except (KeyError, TypeError, AttributeError):
        return {"verdict": "INDETERMINATE", "reason": "the running config has no http servers or logging.logs"}
    if not names:
        return {"verdict": "INDETERMINATE", "reason": "no server routes the %s access log to a logger" % host}
    for name in names:
        lg = logs.get(name) if isinstance(logs, dict) else None
        lg = lg if isinstance(lg, dict) else {}
        w = lg.get("writer") or {}
        f = ((lg.get("encoder") or {}).get("fields") or {}).get("request>uri") or {}
        if w.get("output") == "file" and w.get("filename") == log_path and f.get("filter") == URI_FILTER:
            return {"verdict": "PASS", "logger": name}
    return {"verdict": "INDETERMINATE",
            "reason": "the %s logger does not write %s through the %s URI filter" % (host, log_path, URI_FILTER)}


def aggregate(legs):
    vs = [legs[k]["verdict"] for k in sorted(legs)]
    if "FAIL" in vs:
        return "FAIL"
    return "PASS" if vs and all(v == "PASS" for v in vs) else "INDETERMINATE"


def evaluate(eff, now, res, cfg, cfg_err):
    """Pure: everything gathered -> (verdict, metrics)."""
    legs = {"senders": leg_senders(res, eff), "coverage": leg_coverage(res),
            "logger": leg_logger(cfg, cfg_err, eff["log"], eff["host"])}
    reported = {"by_coding": dict(sorted(res["classes"].items())),
                "gzip_deflate_by_status": dict(sorted(res["gd_status"].items())),
                "future_lines": res["future"]}
    overridden = sorted(k for k in SANDBOX_OVERRIDABLE if eff[k] != ANCHORS[k])
    metrics = {"legs": legs, "reported": reported, "install_at": eff["install_at"], "now": int(now),
               "window_days": round((now - eff["install_at"]) / 86400.0, 2),
               "rule": {"min_requests": eff["min_requests"], "min_days": eff["min_days"],
                        "status_range": eff["status_range"]},
               "rule_overridden": overridden}
    return aggregate(legs), fit_metrics(metrics)


def fit_metrics(m):
    """<= METRICS_MAX_BYTES: shed the per-file list, then senders beyond 3, then the senders list."""
    def size(x):
        return len(json.dumps(x, sort_keys=True).encode("utf-8"))
    cov, snd = m["legs"]["coverage"], m["legs"]["senders"]
    if size(m) > METRICS_MAX_BYTES and isinstance(cov.get("files"), list):
        cov["files"] = "(shed for size)"
    if size(m) > METRICS_MAX_BYTES and isinstance(snd.get("senders"), list):
        snd["senders"] = snd["senders"][:3]
    if size(m) > METRICS_MAX_BYTES:
        snd["senders"] = "(shed for size)"
    return m


# ── the live run ─────────────────────────────────────────────────────────────────────────────

def fetch_config(url=ADMIN_CONFIG_URL, timeout=ADMIN_TIMEOUT_S):
    """The running Caddy config, read-only, never through a proxy. -> (dict, None) or (None, reason)."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8")), None
    except (OSError, ValueError, urllib.error.URLError) as e:
        return None, "the Caddy admin API did not answer: %s" % type(e).__name__


def run(now, anchors, sandbox):
    eff, err = resolve_anchors(anchors, sandbox)
    if err:
        return "INDETERMINATE", {"reason": err}
    res = read_chain(chain(eff["log"]), eff, now)
    cfg, cfg_err = fetch_config()
    verdict, metrics = evaluate(eff, now, res, cfg, cfg_err)
    metrics["sandbox"] = bool(sandbox)
    return verdict, fit_metrics(metrics)


def emit(verdict, metrics):
    """The two contract lines, the token last."""
    return ["OWED_READ_METRICS=" + json.dumps(metrics, sort_keys=True, separators=(",", ":")),
            "OWED_READ_VERDICT=" + verdict]


def main(argv=None):
    ap = argparse.ArgumentParser(description="owed read: inbound-encoding-14d")
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
_SELF_TEST_MIN_CHECKS = 47

# One line exactly as Caddy v2.6.2 wrote it on signal-1 through this log's own filter block, on a
# throwaway 127.0.0.1 instance (2026-10-24): query and credential headers already gone, IPs masked.
REAL_LINE = ('{"level":"info","ts":1792858355.8346436,"logger":"http.log.access.log0","msg":"handled request",'
             '"request":{"remote_ip":"127.0.0.0","remote_port":"56038","proto":"HTTP/1.1","method":"POST",'
             '"host":"127.0.0.1:18471","uri":"/api/search","headers":{"Content-Type":["application/json"],'
             '"User-Agent":["nsf-test/1"],"Cf-Connecting-Ip":["203.0.113.0"],"Content-Encoding":["gzip"],'
             '"Accept":["*/*"],"Content-Length":["22"]}},"user_id":"","duration":0.000015182,"size":2,'
             '"status":200,"resp_headers":{"Server":["Caddy"],"Content-Type":["text/plain; charset=utf-8"]}}')


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

    tmp = tempfile.mkdtemp(prefix="owed-read-ie14.")
    T0 = INSTALL_AT
    DAY = 86400
    NOW = T0 + 14 * DAY + 3600
    EFF = json.loads(json.dumps(ANCHORS))

    def line(ts, method="POST", uri="/api/search", status=200, ce="gzip", ua="python-requests/2.31.0",
             cfip="203.0.113.0", remote="172.70.1.0", cl="22"):
        headers = {}
        for k, v in (("Content-Encoding", ce), ("User-Agent", ua), ("Cf-Connecting-Ip", cfip), ("Content-Length", cl)):
            if v is not None:
                headers[k] = [v]
        return json.dumps({"level": "info", "ts": ts, "logger": "http.log.access.log0", "msg": "handled request",
                           "request": {"remote_ip": remote, "remote_port": "4431", "proto": "HTTP/2.0",
                                       "method": method, "host": API_HOST, "uri": uri, "headers": headers},
                           "user_id": "", "duration": 0.01, "size": 2, "status": status, "resp_headers": {}})

    control = line(T0 + 5, status=400, ua=CONTROL_UA, cfip="198.51.100.0")

    def write(name, lines, gz=False, raw_tail=None):
        p = os.path.join(tmp, name)
        data = "".join(ln + "\n" for ln in lines) + (raw_tail or "")
        if gz:
            with gzip.open(p, "wt", encoding="utf-8") as fh:
                fh.write(data)
        else:
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(data)
        return p

    def judge(paths, eff=None, cfg="ok", now=NOW):
        e = eff or EFF
        res = read_chain(paths, e, now)
        c = CFG if cfg == "ok" else cfg
        return evaluate(e, now, res, c, None if c is not None else "the Caddy admin API did not answer: URLError")

    CFG = {"apps": {"http": {"servers": {"srv0": {"logs": {"logger_names": {"algovault.com": "log1", API_HOST: "log0"},
                                                          "skip_hosts": ["plausible.algovault.com"]}}}}},
           "logging": {"logs": {"log0": {"writer": {"output": "file", "filename": LOG_PATH},
                                         "encoder": {"fields": {"request>uri": {"filter": "regexp"}}}},
                                "log1": {"writer": {"output": "file", "filename": "/var/log/caddy/algovault-access.log"}}}}}

    # ── contract constants ──
    check("the pre-registration is filled: install_at is the real install (on/after 2026-10-24T00:00Z), control_ua is not the placeholder",
          lambda: INSTALL_AT >= 1792800000 and not CONTROL_UA.endswith("/00000000"))
    check("the rule is the spec's: >= 3 requests, >= 2 UTC days, 2xx, gzip+deflate, /24 v4 and /48 v6",
          lambda: (MIN_REQUESTS, MIN_DAYS, STATUS_RANGE, CODINGS, PREFIX_V4, PREFIX_V6)
          == (3, 2, [200, 299], ["deflate", "gzip"], 24, 48))
    check("token -> exit code: PASS 0, FAIL 1, INDETERMINATE 3", lambda: EXIT_FOR == {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3})

    # ── anchors ──
    check("anchors equal to the pre-registration resolve to it", lambda: resolve_anchors(json.loads(json.dumps(ANCHORS)), False) == (ANCHORS, None))
    retuned = dict(ANCHORS, min_requests=50)
    check("a registry row that retunes the rule is INDETERMINATE, naming the key",
          lambda: resolve_anchors(retuned, False)[0] is None and "min_requests" in resolve_anchors(retuned, False)[1])
    ov = dict(ANCHORS, **{SANDBOX_KEY: {"min_requests": 1}})
    check("a sandbox override without --sandbox is refused", lambda: resolve_anchors(ov, False)[0] is None)
    check("under --sandbox min_requests / min_days / status_range are honoured",
          lambda: resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {"min_requests": 1, "min_days": 1, "status_range": [200, 499]}}), True)[0]
          == dict(ANCHORS, min_requests=1, min_days=1, status_range=[200, 499]))
    check("under --sandbox any other key, or an out-of-range value, is refused",
          lambda: resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {"install_at": 1}}), True)[0] is None
          and resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {"min_requests": 0}}), True)[0] is None
          and resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {"status_range": [299, 200]}}), True)[0] is None)

    # ── the words of the rule ──
    e, err = parse_line(REAL_LINE)
    check("a line exactly as Caddy v2.6.2 wrote it parses: method, uri, status, coding, client, UA, length",
          lambda: err is None and (e["method"], e["uri"], e["status"], e["ce"], e["cfip"], e["ua"], e["cl"])
          == ("POST", "/api/search", 200, "gzip", "203.0.113.0", "nsf-test/1", "22"))
    check("labelled gzip/deflate: gzip, deflate, 'gzip, deflate', GZIP, 'identity, gzip'",
          lambda: all(labelled_gzip_deflate(h) for h in ("gzip", "deflate", "gzip, deflate", "GZIP", "identity, gzip")))
    check("not labelled gzip/deflate: br, 'gzip, br', identity, blank, x-gzip, zstd (refused already, or never refused)",
          lambda: not any(labelled_gzip_deflate(h) for h in ("br", "gzip, br", "identity", "", None, "x-gzip", "zstd")))
    check("route: method + lower-cased path, query dropped, segments after the second -> *",
          lambda: (route_of("post", "/API/Search?x=1"), route_of("POST", "/email/unsubscribe/"),
                   route_of("POST", "/api/referral/notifications/7/delivered"), route_of("POST", "/mcp"), route_of("GET", "/"))
          == ("POST /api/search", "POST /email/unsubscribe/*", "POST /api/referral/*/*/*", "POST /mcp", "GET /"))
    check("client: Cf-Connecting-Ip first, else remote_ip; re-masked /24 v4 and /48 v6; unparseable -> None",
          lambda: (prefix_of("203.0.113.77", "172.70.1.0"), prefix_of(None, "172.70.1.9"),
                   prefix_of("2001:db8:1234:5678::1", ""), prefix_of("garbage", "")) ==
          ("203.0.113.0/24", "172.70.1.0/24", "2001:db8:1234::/48", None))
    check("UA family: the first product token, lower-cased",
          lambda: (ua_family("python-requests/2.31.0"), ua_family("Mozilla/5.0 (X11)"), ua_family("Go-http-client/2.0"),
                   ua_family(""), ua_family("(weird)")) == ("python-requests", "mozilla", "go-http-client", "(none)", "(other)"))

    # ── the rule over a chain ──
    def sender_lines(n=3, days=2, **kw):
        return [line(T0 + DAY * (1 + (i % days)) + i, **kw) for i in range(n)]

    v, m = judge([write("a.log", [control] + sender_lines())])
    check("3 gzip requests answered 2xx on 2 UTC days from one (route, /24): FAIL, listed with the UA family",
          lambda: v == "FAIL" and m["legs"]["senders"]["senders"][0]
          == {"route": "POST /api/search", "prefix": "203.0.113.0/24", "requests": 3, "days": 2,
              "ua": ["python-requests"], "bodyless": 0})
    v, m = judge([write("a.log", [control] + sender_lines(n=2))])
    check("2 requests on 2 days: PASS (the floor is 3)", lambda: v == "PASS" and m["legs"]["senders"]["qualifying_requests"] == 2)
    v, m = judge([write("a.log", [control] + sender_lines(days=1))])
    check("3 requests on 1 day: PASS (the floor is 2 days)", lambda: v == "PASS")
    v, m = judge([write("a.log", [control] + sender_lines(n=2) + [line(T0 + 3 * DAY, status=400)])])
    check("a 4xx is not answered 2xx: 2 x 2xx + 1 x 4xx is PASS", lambda: v == "PASS")
    v, m = judge([write("a.log", [control] + sender_lines(n=2) + [line(T0 + 3 * DAY, status=299)])])
    check("299 is 2xx: FAIL", lambda: v == "FAIL")
    v, m = judge([write("a.log", [control] + sender_lines(n=2) + [line(T0 + 3 * DAY, status=304)])])
    check("304 is not 2xx: PASS", lambda: v == "PASS")
    v, m = judge([write("a.log", [control] + sender_lines(n=2) + [line(T0 + 3 * DAY, cfip="203.0.114.9")])])
    check("the third request from another /24 does not make a sender: PASS", lambda: v == "PASS")
    v, m = judge([write("a.log", [control] + sender_lines(n=2) + [line(T0 + 3 * DAY, cfip="203.0.113.200")])])
    check("the third request from the same /24, another address: FAIL", lambda: v == "FAIL")
    v, m = judge([write("a.log", [control] + sender_lines(n=2) + [line(T0 + 3 * DAY, uri="/mcp")])])
    check("the third request on another route does not make a sender: PASS", lambda: v == "PASS")
    v, m = judge([write("a.log", [control] + [line(T0 + DAY * (1 + i % 2) + i, uri="/api/webhooks/w%d/test" % i) for i in range(3)])])
    check("ids in the path never split a client: /api/webhooks/<id>/test x3 on 2 days is ONE sender: FAIL",
          lambda: v == "FAIL" and m["legs"]["senders"]["senders"][0]["route"] == "POST /api/webhooks/*/*")
    v, m = judge([write("a.log", [control] + sender_lines(ce="br", status=200) + sender_lines(ce="gzip, br", status=200))])
    check("br and gzip+br are never counted (refused today): PASS, reported under by_coding.br",
          lambda: v == "PASS" and m["reported"]["by_coding"].get("br") == 6)
    v, m = judge([write("a.log", [control] + sender_lines(ce="deflate", cl=None, method="GET"))])
    check("bodiless GETs labelled deflate still count (towards FAIL) and are reported bodyless",
          lambda: v == "FAIL" and m["legs"]["senders"]["senders"][0]["bodyless"] == 3)
    v, m = judge([write("a.log", [control] + sender_lines(cfip=None, remote="not-an-ip"))])
    check("qualifying requests with no parseable client address: INDETERMINATE, never a silent PASS",
          lambda: v == "INDETERMINATE" and "no parseable client address" in m["legs"]["senders"]["reason"])

    # ── coverage ──
    v, m = judge([write("a.log", sender_lines(n=1))])
    check("no control line anywhere: INDETERMINATE (the chain does not reach the install)",
          lambda: v == "INDETERMINATE" and m["legs"]["coverage"]["verdict"] == "INDETERMINATE")
    live = write("api-encoded-requests.log", sender_lines(n=1))
    old = write("api-encoded-requests-2026-10-30T01-02-03.456.log.gz", [control], gz=True)
    v, m = judge([live, old])
    check("a chain reaching the control line through a .gz backup: PASS, covered_by names the .gz",
          lambda: v == "PASS" and m["legs"]["coverage"]["covered_by"] == os.path.basename(old))
    absent = os.path.join(tmp, "api-encoded-requests-2026-10-29T00-00-00.000.log.gz")
    v, m = judge([live, absent, old])
    check("a backup ABSENT before the control line is a gap: INDETERMINATE",
          lambda: v == "INDETERMINATE" and "absent" in m["legs"]["coverage"]["reason"])
    hit = write("hit.log", sender_lines())
    v, m = judge([hit, absent, old])
    check("a sender found across a gap is still a FAIL (coverage only proves absence)", lambda: v == "FAIL")
    bad = os.path.join(tmp, "bad.log.gz")
    with open(bad, "wb") as fh:
        fh.write(b"not gzip")
    v, m = judge([live, bad, old])
    check("an existing backup that cannot be read before coverage: INDETERMINATE", lambda: v == "INDETERMINATE")
    v, m = judge([write("a.log", [control, "{not json", line(T0 + DAY)])])
    check("an unparseable line in the middle: INDETERMINATE (it could hide a sender)",
          lambda: v == "INDETERMINATE" and "unparseable" in m["legs"]["coverage"]["reason"])
    v, m = judge([write("a.log", [control, line(T0 + DAY)], raw_tail='{"level":"info","ts":17')])
    check("the live file's last line caught mid-write is tolerated: PASS, tail_tolerated 1",
          lambda: v == "PASS" and m["legs"]["coverage"]["tail_tolerated"] == 1)
    v, m = judge([write("a.log", [line(T0 - 2 * DAY), control])])
    check("a line older than the install: INDETERMINATE (not the file the install created)",
          lambda: v == "INDETERMINATE" and "older than the install" in m["legs"]["coverage"]["reason"])
    v, m = judge([write("a.log", [control] + sender_lines())], now=T0 + DAY + 1)
    check("lines at or after now are not counted (the window ends at now)",
          lambda: v == "PASS" and m["reported"]["future_lines"] == 2)

    # ── the chain's order ──
    cdir = os.path.join(tmp, "chain")
    os.makedirs(cdir)
    for nm in ("api-encoded-requests.log", "api-encoded-requests-2026-10-30T01-02-03.456.log.gz",
               "api-encoded-requests-2026-11-02T00-00-00.000.log", "api-encoded-requests-2026-11-02T00-00-00.000.log.gz",
               "api-encoded-requests-2026-10-28T09-09-09.999.log.gz", "algovault-access.log", "api-encoded-requests.log.bak"):
        open(os.path.join(cdir, nm), "w").close()
    got = [os.path.basename(p) for p in chain(os.path.join(cdir, "api-encoded-requests.log"))]
    check("the chain: the live file, then backups newest-first; mid-compression the .log copy wins; strangers ignored",
          lambda: got == ["api-encoded-requests.log", "api-encoded-requests-2026-11-02T00-00-00.000.log",
                          "api-encoded-requests-2026-10-30T01-02-03.456.log.gz",
                          "api-encoded-requests-2026-10-28T09-09-09.999.log.gz"])

    # ── the logger leg ──
    check("logger: the running config routes the api host to this file through the regexp URI filter: PASS",
          lambda: leg_logger(CFG, None, LOG_PATH, API_HOST) == {"verdict": "PASS", "logger": "log0"})
    check("logger: a Caddy v2.9-style list of logger names is read too",
          lambda: leg_logger(json.loads(json.dumps(CFG).replace('"api.algovault.com": "log0"', '"api.algovault.com": ["log0"]')),
                             None, LOG_PATH, API_HOST)["verdict"] == "PASS")
    no_host = json.loads(json.dumps(CFG))
    del no_host["apps"]["http"]["servers"]["srv0"]["logs"]["logger_names"][API_HOST]
    other_file = json.loads(json.dumps(CFG))
    other_file["logging"]["logs"]["log0"]["writer"]["filename"] = "/var/log/caddy/other.log"
    no_filter = json.loads(json.dumps(CFG))
    del no_filter["logging"]["logs"]["log0"]["encoder"]
    check("logger: host unlogged, another file, or no URI filter: INDETERMINATE",
          lambda: all(leg_logger(c, None, LOG_PATH, API_HOST)["verdict"] == "INDETERMINATE" for c in (no_host, other_file, no_filter, {})))
    v, m = judge([write("a.log", [control])], cfg=None)
    check("the admin API not answering: INDETERMINATE, and a found sender still FAILs without it",
          lambda: v == "INDETERMINATE" and judge([write("b.log", [control] + sender_lines())], cfg=None)[0] == "FAIL")

    # ── the forced-FAIL proof the install runs on the live log ──
    eff_forced, _ = resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {"min_requests": 1, "min_days": 1, "status_range": [200, 499]}}), True)
    v, m = judge([write("a.log", [control])], eff=eff_forced)
    check("sandbox min_requests 1 / min_days 1 / 2xx-4xx turns the control line itself into a sender: FAIL, and says so",
          lambda: v == "FAIL" and m["legs"]["senders"]["senders"][0]["ua"] == [CONTROL_UA.split("/")[0]]
          and m["rule_overridden"] == ["min_days", "min_requests", "status_range"])

    # ── metrics + output contract ──
    # 200 senders: each (route, /24) sends 3 requests over 2 UTC days, from 3 UA families.
    many = [line(T0 + DAY * (1 + i % 2) + i, cfip="10.0.%d.0" % (i // 3),
                 uri="/api/r%03d" % (i // 3), ua="Agent%03d/1" % i) for i in range(600)]
    v, m = judge([write("many.log", many)] + [os.path.join(tmp, "x%02d.log" % i) for i in range(40)]
                 + [write("ctl.log", [control])])
    check("metrics stay <= 4 KiB however many senders and files", lambda: len(json.dumps(m, sort_keys=True).encode()) <= METRICS_MAX_BYTES)
    big = fit_metrics({"legs": {"coverage": {"verdict": "INDETERMINATE",
                                             "files": [{"file": "f%03d.log" % i, "present": False} for i in range(200)]},
                                "senders": {"verdict": "FAIL", "senders_total": 10,
                                            "senders": [{"route": "POST /api/x", "prefix": "10.0.%d.0/24" % i, "requests": 3,
                                                         "days": 2, "ua": ["a" * 40] * 3, "bodyless": 0} for i in range(10)]}}})
    check("the per-file list is shed first: when that suffices, the senders list survives intact",
          lambda: big["legs"]["coverage"]["files"] == "(shed for size)" and len(big["legs"]["senders"]["senders"]) == 10
          and len(json.dumps(big, sort_keys=True).encode()) <= METRICS_MAX_BYTES)
    reserved = ("read_id", "wave", "not_before", "expires_at", "attempt", "expired", "script", "duration_s", "runner_reason")
    check("metrics never use a runner-owned key", lambda: not [k for k in m if k in reserved])
    out = emit(v, m)
    check("the output is exactly one metrics line then one verdict line",
          lambda: len(out) == 2 and out[0].startswith("OWED_READ_METRICS={") and out[1] == "OWED_READ_VERDICT=" + v)
    check("aggregate: any FAIL -> FAIL; all PASS -> PASS; otherwise INDETERMINATE",
          lambda: aggregate({"a": {"verdict": "FAIL"}, "b": {"verdict": "INDETERMINATE"}}) == "FAIL"
          and aggregate({"a": {"verdict": "PASS"}, "b": {"verdict": "PASS"}}) == "PASS"
          and aggregate({"a": {"verdict": "PASS"}, "b": {"verdict": "INDETERMINATE"}}) == "INDETERMINATE")

    n = len(ran)
    ok = not failures and n >= _SELF_TEST_MIN_CHECKS
    if n < _SELF_TEST_MIN_CHECKS:
        print("  [FAIL] VACUITY: %d check(s) ran, floor is %d" % (n, _SELF_TEST_MIN_CHECKS))
    print("SELF-TEST: %s (%d check(s) ran, floor %d, %d failure(s))"
          % ("PASS" if ok else "FAIL", n, _SELF_TEST_MIN_CHECKS, len(failures)))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

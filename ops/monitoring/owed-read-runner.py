#!/usr/bin/env python3
"""owed-read-runner.py — OPS-OWED-READ-RUNNER-W1. A time-gated read runs itself.

── THE CLASS THIS RETIRES ──────────────────────────────────────────────────────────────────────
A CLOSE_WHEN leg of the form "read X at time T" waited on a human re-dispatch. Measured: the record
legs of `OPS-ALARM-OWNER-DERIVATION-W1` fired by themselves, while its one human-dispatched 48 h read
(due 2026-10-12T18:10Z) was recorded 2026-10-18T02:35Z — 5.3 days late, while the defect it would have
surfaced kept running. The estate had built the same thing bespoke at least four times (two
`systemd-run --on-active=48h` one-shots that live in the journal and die with a reboot, a date-gated
canary, a once-ever readout gate, a NOT_DUE cron). This is the one schedule they all needed.

── THE CONTRACT ────────────────────────────────────────────────────────────────────────────────
Hourly on signal-1 (`27 * * * *`). For each row of `owed-reads.json` (beside this file):

  NOT_DUE   now < not_before                      -> log only
  DONE      a terminal marker exists              -> log only
  EXPIRED   now >= expires_at, no marker          -> ONE terminal INDETERMINATE record, expired=true; no page
  DUE       otherwise                             -> run the read under its timeout; parse EXACTLY ONE
            `OWED_READ_VERDICT=PASS|FAIL|INDETERMINATE` line and EXACTLY ONE `OWED_READ_METRICS=<json
            object>` line (<= 4 KiB); anything else is INDETERMINATE. Record it through
            canary_result_log ('owed_read'). PASS or FAIL writes the terminal marker — ONLY AFTER the
            record write succeeded. INDETERMINATE retries on the next tick, until expiry.

A missed hour (a deploy, a reboot) loses nothing: the next tick finds the row due. The read's
script must be an installed file beside this one, named `owed-read-<slug>.py` — so a registry that
arrives by declaration-sync (inert data) can only ever SELECT reviewed-installed code, never name it.

── PAGING — ONE ALERT, PAGE-ON-CHANGE, KEY = READ ID ───────────────────────────────────────────
Every run sends `send_telegram.sh OWED_READ_FAIL` the set of reads whose terminal verdict is FAIL
(ALERT_KEYS=<ids>), or `--clear` for an empty set; the wrapper acknowledges a key only on a DELIVERED
page, so a FAIL pages once. PASS, INDETERMINATE, NOT_DUE and expiry never page; nothing announces
completion. The set is built from the markers PLUS this tick's verdicts, so a recorder failure never
delays or suppresses a page; and a row that has become invalid keeps its FAIL key, so it is never
pruned from the acknowledgement by accident. An unreadable registry sends nothing at all.

── THE RUNNER'S OWN VERDICT IS ABOUT ITS CONTRACT, NEVER A READ'S ────────────────────────────────
  OWED_READ_RUNNER_VERDICT=PASS|FAIL|INDETERMINATE due=<n> not_due=<n> done=<n> expired=<n> …
  PASS           the registry read, every row valid, every due/expired row executed AND recorded
  FAIL           a valid row is due and its script is not installed — the read misses its clock
  INDETERMINATE  the registry is unreadable, a row is invalid, or a due/expired row's record or
                 marker could not be written (the read's verdict and its page are unchanged; the
                 marker is withheld, so the next tick re-executes and nothing is lost)
  exit 0 / 1 / 3.

    owed-read-runner.py                      # one tick (cron)
    owed-read-runner.py --validate           # OWED_READ_REGISTRY_VERDICT for the installed registry
    owed-read-runner.py --self-test          # hermetic
    owed-read-runner.py --sandbox DIR [--now EPOCH] [--only ID] [--registry PATH] [--override K=JSON]
        one tick with the recorder, the markers and send_telegram.sh redirected into DIR; `--now`,
        `--only`, `--registry` and `--override` are honoured ONLY here. The read is invoked with
        `--sandbox`, and the overrides travel as anchors['_sandbox_overrides'], which a production
        registry row may never carry.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.environ.get("OWED_READ_REGISTRY", os.path.join(HERE, "owed-reads.json"))
MARKER_DIR = os.environ.get("OWED_READ_MARKER_DIR", "/var/lib/algovault-monitoring/owed-reads")
TG = os.environ.get("OWED_READ_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")

CANARY_NAME = "owed_read"
# LITERAL in fire() and clear(): scripts/check-alert-registry.mjs finds alert ids by POSITION.
ALERT_ID = "OWED_READ_FAIL"
SCHEMA_VERSION = 1
ROW_KEYS = ("id", "wave", "not_before", "expires_at", "script", "timeout_s", "anchors", "criteria")
# A read id becomes a marker FILENAME and a page-on-change KEY, so its grammar is the intersection:
# filename-safe AND inside send_telegram.sh's KEY_RE (pinned equal below by the vitest).
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$")
WRAPPER_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:|/@+-]{0,127}$")
SCRIPT_RE = re.compile(r"^owed-read-[a-z0-9-]+\.py$")
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
WAVE_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]{2,118}$")
TIMEOUT_MAX_S = 1800          # half the cron interval: a read can never overlap the next tick
ANCHORS_MAX_BYTES = 4096
METRICS_MAX_BYTES = 4096      # the read's own budget; canary_result_log refuses a line > 8,192 B WHOLE
CRITERIA_MAX_CHARS = 400
SANDBOX_KEY = "_sandbox_overrides"
# Keys the runner owns in a record; a read emitting one is breaking the contract, not overriding it.
RESERVED_METRIC_KEYS = ("read_id", "wave", "not_before", "expires_at", "attempt", "expired", "script",
                        "duration_s", "runner_reason")
VERDICT_LINE = "OWED_READ_VERDICT="
METRICS_LINE = "OWED_READ_METRICS="
VERDICTS = ("PASS", "FAIL", "INDETERMINATE")
EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
RC_TIMEOUT, RC_NOT_INSTALLED, RC_SYNTHETIC = 124, 127, 3
BODY_MAX_CHARS = 3400
BODY_MAX_READS = 8


def utc_iso(epoch: int) -> str:
    return datetime.fromtimestamp(int(epoch), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(s):
    """RFC 3339 `YYYY-MM-DDTHH:MM:SSZ` -> epoch seconds, or None."""
    if not isinstance(s, str) or not TS_RE.match(s):
        return None
    try:
        return int(datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None


class Config:
    """Every path the runner touches, in ONE place, so the self-test and --sandbox redirect all of
    them together and production can never be half-redirected."""

    def __init__(self, registry=REGISTRY, script_dir=HERE, marker_dir=MARKER_DIR, wrapper=TG,
                 results_path=None, sandbox=False, overrides=None, only=None):
        self.registry, self.script_dir, self.marker_dir = registry, script_dir, marker_dir
        self.wrapper, self.results_path, self.sandbox = wrapper, results_path, sandbox
        self.overrides, self.only = dict(overrides or {}), only


# ── the registry ─────────────────────────────────────────────────────────────────────────────

def load_registry(path):
    """-> (reads list, None) or (None, reason). The registry is a DECLARATION we did not author at
    runtime, so anything we cannot parse is INDETERMINATE — never an empty list."""
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as e:
        return None, "registry unreadable: %s: %s" % (type(e).__name__, str(e)[:120])
    if not isinstance(doc, dict):
        return None, "registry is not a JSON object"
    if doc.get("schema_version") != SCHEMA_VERSION:
        return None, "registry schema_version %r is not %d" % (doc.get("schema_version"), SCHEMA_VERSION)
    if not isinstance(doc.get("reads"), list):
        return None, "registry `reads` is not a list"
    return doc["reads"], None


def row_problems(raw):
    """Everything wrong with ONE row, as data. Empty list = valid. Pure: no filesystem."""
    if not isinstance(raw, dict):
        return ["row is not an object"]
    probs = []
    unknown = sorted(k for k in raw if k not in ROW_KEYS and not k.startswith("_"))
    if unknown:
        probs.append("unknown key(s) %s" % ",".join(unknown))
    missing = [k for k in ROW_KEYS if k not in raw]
    if missing:
        probs.append("missing key(s) %s" % ",".join(missing))
    rid = raw.get("id")
    if not (isinstance(rid, str) and ID_RE.match(rid) and WRAPPER_KEY_RE.match(rid)):
        probs.append("id %r outside [a-z0-9-] (2-64 chars)" % (rid,))
    if not (isinstance(raw.get("wave"), str) and WAVE_RE.match(raw["wave"])):
        probs.append("wave %r is not a wave id" % (raw.get("wave"),))
    nb, ex = parse_ts(raw.get("not_before")), parse_ts(raw.get("expires_at"))
    if nb is None:
        probs.append("not_before %r is not YYYY-MM-DDTHH:MM:SSZ" % (raw.get("not_before"),))
    if ex is None:
        probs.append("expires_at %r is not YYYY-MM-DDTHH:MM:SSZ" % (raw.get("expires_at"),))
    if nb is not None and ex is not None and ex <= nb:
        probs.append("expires_at is not after not_before")
    if not (isinstance(raw.get("script"), str) and SCRIPT_RE.match(raw["script"])):
        probs.append("script %r is not owed-read-<slug>.py beside the runner" % (raw.get("script"),))
    t = raw.get("timeout_s")
    if type(t) is not int or not 1 <= t <= TIMEOUT_MAX_S:
        probs.append("timeout_s %r is not an int in 1..%d" % (t, TIMEOUT_MAX_S))
    a = raw.get("anchors")
    if not isinstance(a, dict):
        probs.append("anchors is not an object")
    else:
        if SANDBOX_KEY in a:
            probs.append("anchors carries %s — a registry row may never carry a sandbox override" % SANDBOX_KEY)
        try:
            if len(json.dumps(a).encode("utf-8")) > ANCHORS_MAX_BYTES:
                probs.append("anchors exceed %d bytes" % ANCHORS_MAX_BYTES)
        except (TypeError, ValueError):
            probs.append("anchors are not JSON-serialisable")
    c = raw.get("criteria")
    if not (isinstance(c, str) and c.strip() and len(c) <= CRITERIA_MAX_CHARS):
        probs.append("criteria is not a non-empty line <= %d chars" % CRITERIA_MAX_CHARS)
    return probs


def validate_registry(reads):
    """-> list of (row-or-None, label, problems). An invalid row is invalid for ITSELF only; a
    duplicated id invalidates every row carrying it (no row may silently win)."""
    out, ids = [], {}
    for i, raw in enumerate(reads):
        rid = raw.get("id") if isinstance(raw, dict) else None
        if isinstance(rid, str):
            ids[rid] = ids.get(rid, 0) + 1
    for i, raw in enumerate(reads):
        probs = row_problems(raw)
        rid = raw.get("id") if isinstance(raw, dict) else None
        if isinstance(rid, str) and ids.get(rid, 0) > 1:
            probs.append("id %r is declared %d times" % (rid, ids[rid]))
        label = rid if isinstance(rid, str) and ID_RE.match(rid) else "#%d" % i
        if probs:
            out.append((None, label, probs))
        else:
            row = dict(raw)
            row["not_before_s"], row["expires_at_s"] = parse_ts(raw["not_before"]), parse_ts(raw["expires_at"])
            out.append((row, label, []))
    return out


def declared_ids(reads):
    """Every grammatical id in the registry, valid row or not — the FAIL set's universe."""
    return {r["id"] for r in reads if isinstance(r, dict) and isinstance(r.get("id"), str) and ID_RE.match(r["id"])}


# ── markers ──────────────────────────────────────────────────────────────────────────────────

def marker_path(cfg, rid):
    return os.path.join(cfg.marker_dir, rid + ".json")


def read_marker(cfg, rid):
    """-> (marker dict or None, error or None). A marker we cannot parse is an ERROR, never 'absent':
    reading it as absent would re-run a terminal read and could double-record it."""
    p = marker_path(cfg, rid)
    if not os.path.exists(p):
        return None, None
    try:
        with open(p, encoding="utf-8") as fh:
            m = json.load(fh)
        if not isinstance(m, dict) or m.get("verdict") not in VERDICTS:
            return None, "marker %s is malformed" % p
        return m, None
    except (OSError, ValueError) as e:
        return None, "marker %s unreadable: %s" % (p, type(e).__name__)


def write_json_atomic(path, obj):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".owed-read.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def bump_attempt(cfg, rid):
    """The attempt counter, persisted BEFORE execution so a crash mid-read still counts. -> (n, err)."""
    p = os.path.join(cfg.marker_dir, rid + ".attempts")
    n = 0
    try:
        if os.path.exists(p):
            with open(p, encoding="utf-8") as fh:
                n = int(fh.read().strip() or 0)
    except (OSError, ValueError):
        n = 0
    n += 1
    try:
        os.makedirs(cfg.marker_dir, exist_ok=True)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("%d\n" % n)
        return n, None
    except OSError as e:
        return n, "attempt counter unwritable: %s" % type(e).__name__


# ── executing a read ─────────────────────────────────────────────────────────────────────────

def parse_read_output(stdout):
    """-> (verdict, metrics dict, reason or None). Exactly one token line and exactly one metrics
    line; anything else — none, two, a bad word, bad JSON, an oversize or colliding object — is
    INDETERMINATE with the reason named."""
    lines = (stdout or "").splitlines()
    vlines = [ln.strip() for ln in lines if ln.strip().startswith(VERDICT_LINE)]
    mlines = [ln.strip() for ln in lines if ln.strip().startswith(METRICS_LINE)]
    if len(vlines) != 1:
        return "INDETERMINATE", {}, "the read printed %d %s line(s), expected exactly 1" % (len(vlines), VERDICT_LINE)
    verdict = vlines[0][len(VERDICT_LINE):]
    if verdict not in VERDICTS:
        return "INDETERMINATE", {}, "the read's verdict %r is not PASS|FAIL|INDETERMINATE" % verdict[:40]
    if len(mlines) != 1:
        return "INDETERMINATE", {}, "the read printed %d %s line(s), expected exactly 1" % (len(mlines), METRICS_LINE)
    raw = mlines[0][len(METRICS_LINE):]
    if len(raw.encode("utf-8")) > METRICS_MAX_BYTES:
        return "INDETERMINATE", {}, "the read's metrics exceed %d bytes" % METRICS_MAX_BYTES
    try:
        metrics = json.loads(raw)
    except ValueError as e:
        return "INDETERMINATE", {}, "the read's metrics are not JSON: %s" % str(e)[:80]
    if not isinstance(metrics, dict):
        return "INDETERMINATE", {}, "the read's metrics are not a JSON object"
    clash = sorted(k for k in metrics if k in RESERVED_METRIC_KEYS)
    if clash:
        return "INDETERMINATE", {}, "the read's metrics use runner-owned key(s) %s" % ",".join(clash)
    return verdict, metrics, None


def run_read(cfg, row, now):
    """-> (verdict, metrics, rc, duration_s, reason). The read runs in its own process GROUP so a
    timeout kills it and every child it started, not just the interpreter."""
    script = os.path.join(cfg.script_dir, row["script"])
    if not os.path.isfile(script):
        return "INDETERMINATE", {}, RC_NOT_INSTALLED, 0.0, "script %s is not installed" % script
    anchors = dict(row["anchors"])
    argv = [sys.executable, "-B", script, "--run", "--now", str(int(now))]
    if cfg.sandbox:
        argv.append("--sandbox")
        if cfg.overrides:
            anchors[SANDBOX_KEY] = cfg.overrides
    t0 = time.monotonic()
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                cwd=cfg.script_dir, start_new_session=True, encoding="utf-8", errors="replace")
    except OSError as e:
        return "INDETERMINATE", {}, RC_NOT_INSTALLED, 0.0, "the read could not start: %s" % e
    try:
        out, err = proc.communicate(json.dumps(anchors), timeout=row["timeout_s"])
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.communicate()
        return ("INDETERMINATE", {}, RC_TIMEOUT, round(time.monotonic() - t0, 2),
                "the read exceeded its timeout of %ds" % row["timeout_s"])
    dur = round(time.monotonic() - t0, 2)
    verdict, metrics, reason = parse_read_output(out)
    if reason and err.strip():
        reason = "%s; stderr: %s" % (reason, err.strip().splitlines()[-1][:160])
    return verdict, metrics, proc.returncode, dur, reason


def record(cfg, row, verdict, rc, metrics, attempt, expired, duration_s=None, runner_reason=None):
    """canary_result_log, imported from beside this file. -> (ok, detail). Never raises."""
    try:
        if HERE not in sys.path:
            sys.path.insert(0, HERE)
        import canary_result_log  # noqa: PLC0415 — deliberately local; resolves beside the runner
        m = {"read_id": row["id"], "wave": row["wave"], "not_before": row["not_before"],
             "expires_at": row["expires_at"], "attempt": attempt, "expired": expired,
             "script": row["script"], "duration_s": duration_s}
        m.update(metrics or {})
        if runner_reason:
            m["runner_reason"] = runner_reason[:300]
        return canary_result_log.append_result(CANARY_NAME, verdict, int(rc), m, path=cfg.results_path)
    except Exception as e:  # noqa: BLE001 — a recorder must never take the runner down
        return False, "%s: %s" % (type(e).__name__, str(e)[:120])


# ── paging ───────────────────────────────────────────────────────────────────────────────────

def recommended_wave(wave):
    """The owning wave's next iteration, as the resolver's TEMPLATE — never a literal number."""
    return re.sub(r"-W\d+$", "", wave) + "-W{NEXT}"


def legs_brief(metrics):
    legs = metrics.get("legs") if isinstance(metrics, dict) else None
    if not isinstance(legs, dict) or not legs:
        return "legs: (none reported)"
    parts = []
    for name in sorted(legs):
        leg = legs[name] if isinstance(legs[name], dict) else {}
        scalars = ["%s=%s" % (k, leg[k]) for k in sorted(leg)
                   if k != "verdict" and isinstance(leg[k], (int, str)) and not isinstance(leg[k], bool)][:3]
        parts.append(" ".join([name, str(leg.get("verdict", "?"))] + scalars))
    return "legs: " + " · ".join(parts)


def build_body(fails):
    """`fails` = [(row-or-stub, marker-or-tick-result)]. Bounded to one Telegram message."""
    out = ["A pre-registered read missed — %d read(s) ended FAIL:" % len(fails), ""]
    for row, m in fails[:BODY_MAX_READS]:
        out += ["read %s (wave %s)" % (row["id"], row.get("wave", "?")),
                "criteria: %s" % row.get("criteria", "(row no longer in the registry)"),
                "recorded %s, attempt %s" % (m.get("at", "?"), m.get("attempt", "?")),
                legs_brief(m.get("metrics", {})),
                "Action: /b — %s" % recommended_wave(row.get("wave", "OPS-OWED-READ")),
                ""]
    if len(fails) > BODY_MAX_READS:
        out.append("(+%d more FAIL read(s) — see the records)" % (len(fails) - BODY_MAX_READS))
    out.append("Evidence: canary owed_read records in the vault's canary-results.jsonl (one per read_id).")
    body = "\n".join(out)
    return body if len(body) <= BODY_MAX_CHARS else body[:BODY_MAX_CHARS - 20] + "\n… (truncated)"


def fire(cfg, body, keys, log):
    TG = cfg.wrapper  # noqa: N806 — the literal `[TG, "<ID>", "CRITICAL_PERSISTENT"` form is what the registry gate reads
    argv = [TG, "OWED_READ_FAIL", "CRITICAL_PERSISTENT", "-"]
    env = dict(os.environ, ALERT_KEYS=" ".join(keys))
    try:
        p = subprocess.run(argv, input=body, capture_output=True, encoding="utf-8", errors="replace",
                           timeout=30, env=env)
        log("wrapper[%s] fire keys=%s exit=%d out=%s" % (ALERT_ID, " ".join(keys), p.returncode,
                                                        (p.stdout or p.stderr).strip()[:160]))
    except (OSError, subprocess.SubprocessError) as e:
        log("wrapper[%s] fire FAILED to run: %s" % (ALERT_ID, e))


def clear(cfg, reason, log):
    TG = cfg.wrapper  # noqa: N806
    argv = [TG, "--clear", "OWED_READ_FAIL", reason]
    try:
        p = subprocess.run(argv, capture_output=True, encoding="utf-8", errors="replace", timeout=30)
        log("wrapper[%s] --clear exit=%d out=%s" % (ALERT_ID, p.returncode, (p.stdout or p.stderr).strip()[:160]))
    except (OSError, subprocess.SubprocessError) as e:
        log("wrapper[%s] --clear FAILED to run: %s" % (ALERT_ID, e))


# ── one tick ─────────────────────────────────────────────────────────────────────────────────

def tick(cfg, now, log=print):
    """-> summary dict. Every path prints a POSITIVE line; the last one is the verdict."""
    c = {"reads": 0, "due": 0, "not_due": 0, "done": 0, "expired": 0, "invalid": 0, "unrecorded": 0,
         "not_installed": 0, "state_errors": 0}
    reads, err = load_registry(cfg.registry)
    if err:
        log("OWED_READ_REGISTRY_UNREADABLE: %s — no read evaluated, nothing dispatched" % err)
        return _finish(c, "INDETERMINATE", log, dispatched=None)
    if cfg.only:
        reads = [r for r in reads if isinstance(r, dict) and r.get("id") == cfg.only]
    c["reads"] = len(reads)
    log("OWED_READ_REGISTRY path=%s reads=%d%s" % (cfg.registry, len(reads), " SANDBOX" if cfg.sandbox else ""))
    fails = {}                     # id -> (row-or-stub, {at, attempt, metrics})
    for row, label, probs in validate_registry(reads):
        if row is None:
            c["invalid"] += 1
            log("OWED_READ row=%s state=INVALID %s" % (label, "; ".join(probs)[:400]))
            continue
        try:
            _one_row(cfg, row, now, c, fails, log)
        except Exception as e:  # noqa: BLE001 — one row's fault blinds that row only
            c["state_errors"] += 1
            log("OWED_READ row=%s state=ERROR %s: %s" % (row["id"], type(e).__name__, str(e)[:160]))
    # FAIL keys of rows that are present but invalid still travel, so an edit never prunes an ack.
    for rid in sorted(declared_ids(reads) - {r[0]["id"] for r in validate_registry(reads) if r[0]}):
        m, merr = read_marker(cfg, rid)
        if m and m.get("verdict") == "FAIL":
            fails.setdefault(rid, ({"id": rid}, m))
    keys = sorted(fails)
    if keys:
        fire(cfg, build_body([fails[k] for k in keys]), keys, log)
        dispatched = ("fire", keys)
    else:
        clear(cfg, "no owed read is in FAIL (%d read(s) declared)" % c["reads"], log)
        dispatched = ("clear", [])
    if c["invalid"] or c["unrecorded"] or c["state_errors"]:
        verdict = "INDETERMINATE"
    elif c["not_installed"]:
        verdict = "FAIL"
    else:
        verdict = "PASS"
    return _finish(c, verdict, log, dispatched)


def _one_row(cfg, row, now, c, fails, log):
    rid = row["id"]
    m, merr = read_marker(cfg, rid)
    if merr:
        c["state_errors"] += 1
        log("OWED_READ row=%s state=ERROR %s — not re-run" % (rid, merr))
        return
    if m is not None:
        c["done"] += 1
        log("OWED_READ row=%s state=DONE verdict=%s at=%s attempt=%s%s"
            % (rid, m["verdict"], m.get("at"), m.get("attempt"), " expired" if m.get("expired") else ""))
        if m["verdict"] == "FAIL":
            fails[rid] = (row, m)
        return
    if now >= row["expires_at_s"]:
        c["expired"] += 1
        attempt, aerr = bump_attempt(cfg, rid)
        ok, detail = record(cfg, row, "INDETERMINATE", RC_SYNTHETIC, {}, attempt, True,
                            runner_reason="expired at %s without a terminal verdict" % row["expires_at"])
        log("OWED_READ row=%s state=EXPIRED expires_at=%s attempt=%d %s"
            % (rid, row["expires_at"], attempt, _rec(ok, detail)))
        if aerr:
            c["state_errors"] += 1
            log("OWED_READ row=%s STATE_ERROR %s" % (rid, aerr))
        if not ok:
            c["unrecorded"] += 1
            return
        _terminal(cfg, row, "INDETERMINATE", attempt, True, {}, now, detail, c, log)
        return
    if now < row["not_before_s"]:
        c["not_due"] += 1
        log("OWED_READ row=%s state=NOT_DUE not_before=%s in=%.1fh"
            % (rid, row["not_before"], (row["not_before_s"] - now) / 3600.0))
        return
    c["due"] += 1
    attempt, aerr = bump_attempt(cfg, rid)
    if aerr:
        c["state_errors"] += 1
        log("OWED_READ row=%s STATE_ERROR %s" % (rid, aerr))
    verdict, metrics, rc, dur, reason = run_read(cfg, row, now)
    if rc == RC_NOT_INSTALLED and reason and "not installed" in reason:
        c["not_installed"] += 1
    ok, detail = record(cfg, row, verdict, rc, metrics, attempt, False, dur, reason)
    log("OWED_READ row=%s state=DUE verdict=%s rc=%s duration_s=%s attempt=%d %s%s"
        % (rid, verdict, rc, dur, attempt, _rec(ok, detail), (" reason=%s" % reason[:200]) if reason else ""))
    if verdict == "FAIL":
        # From THIS tick's verdict, not the marker: a recorder failure must never delay the page.
        fails[rid] = (row, {"at": utc_iso(now), "attempt": attempt, "metrics": metrics})
    if not ok:
        c["unrecorded"] += 1
        log("OWED_READ row=%s MARKER_WITHHELD — the record did not land; the next tick re-executes" % rid)
        return
    if verdict in ("PASS", "FAIL"):
        _terminal(cfg, row, verdict, attempt, False, metrics, now, detail, c, log)


def _terminal(cfg, row, verdict, attempt, expired, metrics, now, detail, c, log):
    try:
        write_json_atomic(marker_path(cfg, row["id"]),
                          {"read_id": row["id"], "verdict": verdict, "at": utc_iso(now), "attempt": attempt,
                           "expired": expired, "record": detail, "metrics": metrics})
        log("OWED_READ row=%s MARKER_WRITTEN verdict=%s" % (row["id"], verdict))
    except OSError as e:
        c["state_errors"] += 1
        log("OWED_READ row=%s MARKER_FAILED %s: %s" % (row["id"], type(e).__name__, e))


def _rec(ok, detail):
    return ("CANARY_RESULT_LOG=%s" % detail) if ok else ("CANARY_RESULT_LOG_FAILED=%s" % detail)


def _finish(c, verdict, log, dispatched):
    log("OWED_READ_RUNNER_VERDICT=%s due=%d not_due=%d done=%d expired=%d reads=%d invalid=%d "
        "unrecorded=%d not_installed=%d state_errors=%d"
        % (verdict, c["due"], c["not_due"], c["done"], c["expired"], c["reads"], c["invalid"],
           c["unrecorded"], c["not_installed"], c["state_errors"]))
    return dict(c, verdict=verdict, dispatched=dispatched)


def validate(cfg, log=print):
    """--validate: is the registry, as installed, executable? Script presence is checked here."""
    reads, err = load_registry(cfg.registry)
    if err:
        log(err)
        log("OWED_READ_REGISTRY_VERDICT=INDETERMINATE")
        return 3
    bad = 0
    for row, label, probs in validate_registry(reads):
        if row is not None and not os.path.isfile(os.path.join(cfg.script_dir, row["script"])):
            probs = ["script %s is not installed beside the runner" % row["script"]]
        bad += bool(probs)
        log("OWED_READ_REGISTRY row=%s %s" % (label, "OK" if not probs else "INVALID " + "; ".join(probs)))
    log("OWED_READ_REGISTRY reads=%d invalid=%d" % (len(reads), bad))
    log("OWED_READ_REGISTRY_VERDICT=%s" % ("FAIL" if bad else "PASS"))
    return 1 if bad else 0


# ── --sandbox ────────────────────────────────────────────────────────────────────────────────

STUB_WRAPPER = """#!/bin/sh
# owed-read-runner --sandbox stub: records every call, delivers nothing.
{ printf 'argv=%s ALERT_KEYS=%s\\n' "$*" "${ALERT_KEYS:-}"; [ "$1" = "--clear" ] || cat; printf '\\n--\\n'; } >> "$(dirname "$0")/wrapper-calls.log"
echo "SANDBOX_STUB: recorded, no POST"
"""


def sandbox_config(args):
    d = os.path.abspath(args.sandbox)
    os.makedirs(d, exist_ok=True)
    stub = os.path.join(d, "send_telegram.sh")
    with open(stub, "w", encoding="utf-8") as fh:
        fh.write(STUB_WRAPPER)
    os.chmod(stub, 0o755)
    overrides = {}
    for kv in args.override or []:
        k, _, v = kv.partition("=")
        overrides[k] = json.loads(v)
    return Config(registry=args.registry or REGISTRY, marker_dir=os.path.join(d, "owed-reads"), wrapper=stub,
                  results_path=os.path.join(d, "canary-results.jsonl"), sandbox=True, overrides=overrides,
                  only=args.only)


def parse_args(argv):
    ap = argparse.ArgumentParser(description="owed-read runner")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--sandbox", metavar="DIR")
    ap.add_argument("--now", type=int)
    ap.add_argument("--only")
    ap.add_argument("--registry")
    ap.add_argument("--override", action="append", metavar="KEY=JSON")
    a = ap.parse_args(argv)
    if not a.sandbox and (a.now is not None or a.only or a.registry or a.override):
        ap.error("--now, --only, --registry and --override are honoured only with --sandbox")
    return a


def main(argv=None):
    a = parse_args(sys.argv[1:] if argv is None else argv)
    if a.self_test:
        return self_test()
    if a.validate:
        return validate(Config())
    try:
        cfg = sandbox_config(a) if a.sandbox else Config()
        if cfg.sandbox:
            print("SANDBOX dir=%s results=%s markers=%s wrapper=%s"
                  % (os.path.dirname(cfg.wrapper), cfg.results_path, cfg.marker_dir, cfg.wrapper))
        now = a.now if (a.sandbox and a.now is not None) else int(time.time())
        return EXIT_FOR[tick(cfg, now)["verdict"]]
    except Exception as e:  # noqa: BLE001 — an unexpected fault verified nothing
        print("OWED_READ_RUNNER_FAULT %s: %s" % (type(e).__name__, e))
        print("OWED_READ_RUNNER_VERDICT=INDETERMINATE due=0 not_due=0 done=0 expired=0")
        return 3


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

# Floor = the measured check count, so removing any scenario trips it.
_SELF_TEST_MIN_CHECKS = 51

_STUB_READS = {
    "owed-read-pass.py": 'print("note"); print("OWED_READ_METRICS={\\"legs\\": {\\"L1\\": {\\"verdict\\": \\"PASS\\", \\"lines\\": 0}}}"); print("OWED_READ_VERDICT=PASS")',
    "owed-read-fail.py": 'print("OWED_READ_METRICS={\\"legs\\": {\\"L2\\": {\\"verdict\\": \\"FAIL\\", \\"failing\\": \\"BB\\"}}}"); print("OWED_READ_VERDICT=FAIL")',
    "owed-read-indet.py": 'print("OWED_READ_METRICS={}"); print("OWED_READ_VERDICT=INDETERMINATE")',
    "owed-read-notoken.py": 'print("OWED_READ_METRICS={}")',
    "owed-read-twotokens.py": 'print("OWED_READ_METRICS={}"); print("OWED_READ_VERDICT=PASS"); print("OWED_READ_VERDICT=PASS")',
    "owed-read-badjson.py": 'print("OWED_READ_METRICS={not json"); print("OWED_READ_VERDICT=PASS")',
    "owed-read-badword.py": 'print("OWED_READ_METRICS={}"); print("OWED_READ_VERDICT=MAYBE")',
    "owed-read-nometrics.py": 'print("OWED_READ_VERDICT=PASS")',
    "owed-read-big.py": 'print("OWED_READ_METRICS=" + __import__("json").dumps({"x": "y" * 5000})); print("OWED_READ_VERDICT=PASS")',
    "owed-read-reserved.py": 'print("OWED_READ_METRICS={\\"attempt\\": 99}"); print("OWED_READ_VERDICT=PASS")',
    "owed-read-sleep.py": 'import time; time.sleep(30); print("OWED_READ_METRICS={}"); print("OWED_READ_VERDICT=PASS")',
    "owed-read-echo.py": ('import json, sys; a = json.loads(sys.stdin.read()); '
                          'print("OWED_READ_METRICS=" + json.dumps({"argv_sandbox": "--sandbox" in sys.argv, '
                          '"overrides": a.get("_sandbox_overrides"), "now": sys.argv[sys.argv.index("--now") + 1]})); '
                          'print("OWED_READ_VERDICT=INDETERMINATE")'),
}

# A wrapper stub with the one page-on-change property the runner relies on: a key already in the ack
# does not POST again; --clear drops the ack. (The real wrapper's semantics are its own self-test's.)
_STUB_ACK_WRAPPER = """#!/bin/sh
d="$(dirname "$0")"; ack="$d/ack"
if [ "$1" = "--clear" ]; then rm -f "$ack"; echo "CLEAR $2" >> "$d/calls"; exit 0; fi
cat > /dev/null
for k in $ALERT_KEYS; do
  if ! grep -qx "$k" "$ack" 2>/dev/null; then
    echo "POST $1 $2 keys=$ALERT_KEYS" >> "$d/calls"; printf '%s\\n' $ALERT_KEYS > "$ack"; exit 0
  fi
done
echo "UNCHANGED $1 keys=$ALERT_KEYS" >> "$d/calls"
"""


def self_test():
    failures, ran = [], []
    lines = []

    def check(name, fn):
        ran.append(name)
        try:
            ok = fn()
        except Exception as e:  # noqa: BLE001 — an assertion that raises is a crash, not a verdict
            failures.append("%s: raised %s: %s" % (name, type(e).__name__, e))
            print("  [FAIL] %s (raised %s: %s)" % (name, type(e).__name__, str(e)[:120]))
            return
        if not ok:
            failures.append(name)
        print("  [%s] %s" % ("ok" if ok else "FAIL", name))

    root = tempfile.mkdtemp(prefix="owed-read-runner-selftest.")
    scripts = os.path.join(root, "scripts")
    os.makedirs(scripts)
    for name, src in _STUB_READS.items():
        with open(os.path.join(scripts, name), "w", encoding="utf-8") as fh:
            fh.write(src + "\n")
    NOW = 1792400000

    def row(rid, script, nb=-3600, ex=+86400, **kw):
        r = {"id": rid, "wave": "OPS-EXAMPLE-READ-W3", "not_before": utc_iso(NOW + nb),
             "expires_at": utc_iso(NOW + ex), "script": script, "timeout_s": kw.pop("timeout_s", 20),
             "anchors": kw.pop("anchors", {"cohort": ["HL|X"]}), "criteria": "a test read"}
        r.update(kw)
        return r

    case_n = [0]

    def env(rows, results_broken=False, registry_text=None):
        """A fresh sandbox: registry, markers, results file, ack-stub wrapper."""
        case_n[0] += 1
        d = os.path.join(root, "case%02d" % case_n[0])
        os.makedirs(d)
        reg = os.path.join(d, "owed-reads.json")
        with open(reg, "w", encoding="utf-8") as fh:
            fh.write(registry_text if registry_text is not None
                     else json.dumps({"schema_version": SCHEMA_VERSION, "reads": rows}))
        w = os.path.join(d, "send_telegram.sh")
        with open(w, "w", encoding="utf-8") as fh:
            fh.write(_STUB_ACK_WRAPPER)
        os.chmod(w, 0o755)
        if results_broken:
            open(os.path.join(d, "blocker"), "w").close()
            results = os.path.join(d, "blocker", "canary-results.jsonl")     # parent is a FILE
        else:
            results = os.path.join(d, "canary-results.jsonl")
        return Config(registry=reg, script_dir=scripts, marker_dir=os.path.join(d, "markers"), wrapper=w,
                      results_path=results), d

    def run(cfg, now=NOW):
        out = []
        s = tick(cfg, now, log=out.append)
        lines.extend(out)
        s["lines"] = out
        return s

    def records(cfg):
        if not os.path.exists(cfg.results_path):
            return []
        with open(cfg.results_path, encoding="utf-8") as fh:
            return [json.loads(ln) for ln in fh if ln.strip()]

    def calls(d):
        p = os.path.join(d, "calls")
        return open(p, encoding="utf-8").read().splitlines() if os.path.exists(p) else []

    def marker(cfg, rid):
        return read_marker(cfg, rid)[0]

    # ── #1 a run before not_before ──
    cfg, d = env([row("early", "owed-read-pass.py", nb=+7200)])
    s = run(cfg)
    check("#1 before not_before: NOT_DUE, nothing executed, nothing recorded, runner PASS",
          lambda: s["not_due"] == 1 and s["due"] == 0 and records(cfg) == [] and marker(cfg, "early") is None
          and s["verdict"] == "PASS" and any("state=NOT_DUE" in ln for ln in s["lines"]))

    # ── #2 a second run after a terminal marker ──
    cfg, d = env([row("twice", "owed-read-pass.py")])
    s1, s2 = run(cfg), run(cfg)
    check("#2 PASS read: recorded once and marked terminal", lambda: s1["due"] == 1 and len(records(cfg)) == 1
          and (marker(cfg, "twice") or {}).get("verdict") == "PASS")
    check("#2 second tick after the marker is DONE: not re-executed, no second record",
          lambda: s2["done"] == 1 and s2["due"] == 0 and len(records(cfg)) == 1)

    # ── #3 expiry ──
    cfg, d = env([row("late", "owed-read-pass.py", nb=-90000, ex=-60)])
    s1, s2 = run(cfg), run(cfg)
    rec = (records(cfg) or [{}])[0]
    check("#3 expiry: ONE terminal INDETERMINATE record with expired=true",
          lambda: len(records(cfg)) == 1 and rec.get("verdict") == "INDETERMINATE"
          and rec["metrics"].get("expired") is True and s1["expired"] == 1 and s2["done"] == 1)
    check("#3 expiry pages nothing — the only wrapper call is the empty-set --clear",
          lambda: all(c.startswith("CLEAR") for c in calls(d)) and len(calls(d)) == 2)

    # ── #4 the read's output contract ──
    for script, label in (("owed-read-notoken.py", "no token"), ("owed-read-twotokens.py", "two tokens"),
                          ("owed-read-badjson.py", "bad JSON"), ("owed-read-badword.py", "a bad verdict word"),
                          ("owed-read-nometrics.py", "no metrics line")):
        cfg, d = env([row("contract", script)])
        s = run(cfg)
        r = (records(cfg) or [{}])[0]
        check("#4 a read printing %s => INDETERMINATE, recorded, no marker, the reason named" % label,
              lambda cfg=cfg, r=r: r.get("verdict") == "INDETERMINATE" and marker(cfg, "contract") is None
              and "runner_reason" in r.get("metrics", {}))

    cfg, d = env([row("big", "owed-read-big.py")])
    run(cfg)
    check("#4 oversize metrics => INDETERMINATE (the 4 KiB budget is enforced)",
          lambda: records(cfg)[0]["verdict"] == "INDETERMINATE" and "exceed" in records(cfg)[0]["metrics"]["runner_reason"])
    cfg, d = env([row("clash", "owed-read-reserved.py")])
    run(cfg)
    check("#4 a read emitting a runner-owned key => INDETERMINATE, and the runner's attempt stands",
          lambda: records(cfg)[0]["verdict"] == "INDETERMINATE" and records(cfg)[0]["metrics"]["attempt"] == 1)

    # ── #5 timeout ──
    cfg, d = env([row("slow", "owed-read-sleep.py", timeout_s=1)])
    t0 = time.monotonic()
    s = run(cfg)
    took = time.monotonic() - t0
    check("#5 a read past its timeout => INDETERMINATE (rc 124), killed, no marker",
          lambda: records(cfg)[0]["verdict"] == "INDETERMINATE" and records(cfg)[0]["exit_code"] == RC_TIMEOUT
          and took < 10 and marker(cfg, "slow") is None)

    # ── #6 FAIL pages once; PASS and INDETERMINATE never page ──
    cfg, d = env([row("missed", "owed-read-fail.py")])
    s1, s2 = run(cfg), run(cfg)
    check("#6 FAIL: the wrapper is called with the literal alert id, CRITICAL_PERSISTENT and key = read id",
          lambda: s1["dispatched"] == ("fire", ["missed"]) and calls(d)[0] == "POST OWED_READ_FAIL CRITICAL_PERSISTENT keys=missed")
    check("#6 FAIL pages ONCE: the second tick re-sends the key and the ack suppresses it",
          lambda: s2["dispatched"] == ("fire", ["missed"]) and [c.split()[0] for c in calls(d)] == ["POST", "UNCHANGED"])
    for script, v in (("owed-read-pass.py", "PASS"), ("owed-read-indet.py", "INDETERMINATE")):
        cfg, d = env([row("quiet", script)])
        s = run(cfg)
        check("#6 %s never pages — the run sends only the empty-set --clear" % v,
              lambda s=s, d=d: s["dispatched"] == ("clear", []) and calls(d) == ["CLEAR OWED_READ_FAIL"])

    # ── #7 the marker is written only after a successful record; #8 a recorder failure changes no
    #    read verdict and no page, withholds the marker, and the runner says so ──
    cfg_b, d_b = env([row("rec", "owed-read-fail.py")], results_broken=True)
    sb = run(cfg_b)
    check("#7 recorder broken: NO marker written, MARKER_WITHHELD logged",
          lambda: marker(cfg_b, "rec") is None and any("MARKER_WITHHELD" in ln for ln in sb["lines"]))
    check("#8 recorder broken: the page still goes out, keyed exactly as with a working recorder",
          lambda: sb["dispatched"] == ("fire", ["rec"]) and calls(d_b)[0].startswith("POST OWED_READ_FAIL"))
    cfg_ok, d_ok = env([row("rec", "owed-read-fail.py")])
    sok = run(cfg_ok)
    check("#8 the read's verdict line is identical either way; only the recorder detail differs",
          lambda: [ln.split(" CANARY_RESULT_LOG")[0].split(" duration_s=")[0] for ln in sb["lines"] if "state=DUE" in ln]
          == [ln.split(" CANARY_RESULT_LOG")[0].split(" duration_s=")[0] for ln in sok["lines"] if "state=DUE" in ln])
    check("#8 recorder broken: the runner reports unrecorded=1 and INDETERMINATE (exit 3), never a silent PASS",
          lambda: sb["unrecorded"] == 1 and sb["verdict"] == "INDETERMINATE" and EXIT_FOR[sb["verdict"]] == 3
          and sok["verdict"] == "PASS")
    cfg_b.results_path = cfg_ok.results_path.replace(d_ok, d_b)          # repair the recorder
    sr = run(cfg_b)
    check("#7 recorder repaired: the next tick re-executes, records, and only then marks (attempt 2)",
          lambda: sr["due"] == 1 and (marker(cfg_b, "rec") or {}).get("attempt") == 2 and len(records(cfg_b)) == 1)

    # ── #9 an invalid registry row blinds only itself ──
    bad = row("broken", "owed-read-pass.py")
    bad["not_before"] = "tomorrow"
    cfg, d = env([bad, row("fine", "owed-read-pass.py")])
    s = run(cfg)
    check("#9 one invalid row: the valid row still executes and is recorded",
          lambda: s["due"] == 1 and [r["metrics"]["read_id"] for r in records(cfg)] == ["fine"])
    check("#9 the invalid row is reported by name and the runner is INDETERMINATE, not PASS",
          lambda: s["invalid"] == 1 and s["verdict"] == "INDETERMINATE"
          and any("row=broken state=INVALID" in ln for ln in s["lines"]))
    for label, mut in (("a duplicated id", lambda r: r.update(id="fine")),
                       ("an unknown key", lambda r: r.update(not_befor="x")),
                       ("a script outside the grammar", lambda r: r.update(script="../owed-read-pass.py")),
                       ("a path for a script", lambda r: r.update(script="/bin/sh")),
                       ("a sandbox override in a production row", lambda r: r["anchors"].update({SANDBOX_KEY: {"x": 1}})),
                       ("expires_at not after not_before", lambda r: r.update(expires_at=r["not_before"])),
                       ("an id carrying a slash", lambda r: r.update(id="a/b")),
                       ("a timeout past half the interval", lambda r: r.update(timeout_s=3600))):
        r = row("victim", "owed-read-pass.py")
        mut(r)
        rows_ = [r, row("fine", "owed-read-pass.py")] if label == "a duplicated id" else [r]
        res = validate_registry(rows_)
        check("#9 refused: %s" % label, lambda res=res: any(x[0] is None for x in res))

    # ── the registry itself ──
    cfg, d = env([], registry_text="{not json")
    s = run(cfg)
    check("an unreadable registry is INDETERMINATE and dispatches NOTHING (not even --clear)",
          lambda: s["verdict"] == "INDETERMINATE" and s["dispatched"] is None and calls(d) == [])
    cfg, d = env([], registry_text=json.dumps({"schema_version": 2, "reads": []}))
    check("a registry of the wrong schema_version is INDETERMINATE", lambda: run(cfg)["verdict"] == "INDETERMINATE")
    cfg, d = env([])
    s = run(cfg)
    check("reads=0 is a REPORTED pass: the line says reads=0 and the empty set is cleared",
          lambda: s["verdict"] == "PASS" and any("reads=0" in ln for ln in s["lines"]) and s["dispatched"] == ("clear", []))

    # ── a due row whose script is not installed ──
    cfg, d = env([row("ghost", "owed-read-nowhere.py")])
    s = run(cfg)
    check("a DUE row whose script is not installed: runner FAIL, an INDETERMINATE record (rc 127) says why",
          lambda: s["verdict"] == "FAIL" and records(cfg)[0]["exit_code"] == RC_NOT_INSTALLED
          and "not installed" in records(cfg)[0]["metrics"]["runner_reason"])

    # ── attempts and record shape ──
    cfg, d = env([row("retry", "owed-read-indet.py")])
    run(cfg)
    run(cfg)
    recs = records(cfg)
    check("INDETERMINATE retries each tick; attempt counts 1, 2 and no marker is written",
          lambda: [r["metrics"]["attempt"] for r in recs] == [1, 2] and marker(cfg, "retry") is None)
    check("the record is canary 'owed_read' and carries read_id, wave, not_before, attempt, expired",
          lambda: recs[0]["canary"] == CANARY_NAME and all(k in recs[0]["metrics"] for k in
                                                           ("read_id", "wave", "not_before", "attempt", "expired")))

    # ── keys survive an edit; rollback clears ──
    cfg, d = env([row("held", "owed-read-fail.py")])
    run(cfg)
    broken = row("held", "owed-read-fail.py")
    broken["timeout_s"] = 0
    with open(cfg.registry, "w", encoding="utf-8") as fh:
        json.dump({"schema_version": SCHEMA_VERSION, "reads": [broken]}, fh)
    s = run(cfg)
    check("a FAIL read whose row became invalid keeps its key (the ack is never pruned by an edit)",
          lambda: s["dispatched"] == ("fire", ["held"]))
    with open(cfg.registry, "w", encoding="utf-8") as fh:
        json.dump({"schema_version": SCHEMA_VERSION, "reads": []}, fh)
    s = run(cfg)
    check("rollback — the row deleted: the FAIL key leaves the set and the alert is cleared; the marker is kept",
          lambda: s["dispatched"] == ("clear", []) and marker(cfg, "held") is not None)

    # ── --sandbox passthrough, and its refusal outside the sandbox ──
    cfg, d = env([row("echo", "owed-read-echo.py")])
    cfg.sandbox, cfg.overrides = True, {"l3_ceiling": -1}
    run(cfg)
    m = records(cfg)[0]["metrics"]
    check("--sandbox reaches the read: the flag, the overrides as anchors['_sandbox_overrides'], the pinned now",
          lambda: m["argv_sandbox"] is True and m["overrides"] == {"l3_ceiling": -1} and m["now"] == str(NOW))
    cfg, d = env([row("echo", "owed-read-echo.py")])
    run(cfg)
    m = records(cfg)[0]["metrics"]
    check("outside --sandbox the read gets neither the flag nor any override",
          lambda: m["argv_sandbox"] is False and m["overrides"] is None)

    def cli_refuses(argv):
        try:
            import contextlib
            import io
            with contextlib.redirect_stderr(io.StringIO()):
                parse_args(argv)
        except SystemExit as e:
            return e.code == 2
        return False
    check("--now / --only / --registry / --override are refused without --sandbox",
          lambda: all(cli_refuses(a) for a in (["--now", "1"], ["--only", "x"], ["--registry", "r"], ["--override", "a=1"])))

    # ── contract constants ──
    check("token -> exit code: PASS 0, FAIL 1, INDETERMINATE 3", lambda: EXIT_FOR == {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3})
    check("every grammatical id is also a page-on-change key the wrapper accepts",
          lambda: all(WRAPPER_KEY_RE.match(i) for i in ("candle-request-24h", "a1", "x" * 64)) and not ID_RE.match("a/b"))
    check("the summary line leads with the four counts the contract names",
          lambda: re.search(r"^OWED_READ_RUNNER_VERDICT=(PASS|FAIL|INDETERMINATE) due=\d+ not_due=\d+ done=\d+ expired=\d+ ",
                            [ln for ln in lines if ln.startswith("OWED_READ_RUNNER_VERDICT=")][-1]) is not None)
    body = build_body([(row("missed", "owed-read-fail.py"), {"at": "2026-10-23T06:27:00Z", "attempt": 1,
                                                            "metrics": {"legs": {"L2": {"verdict": "FAIL", "failing": "BB"}}}})])
    check("the page body names the read, its criteria, the failing leg and a W{NEXT} action — no literal next wave",
          lambda: "read missed (wave OPS-EXAMPLE-READ-W3)" in body and "L2 FAIL failing=BB" in body
          and "Action: /b — OPS-EXAMPLE-READ-W{NEXT}" in body and len(body) <= BODY_MAX_CHARS)
    many = build_body([(row("r%02d" % i, "owed-read-fail.py"), {"metrics": {"legs": {"L": {"verdict": "FAIL", "x": "y" * 500}}}})
                       for i in range(20)])
    check("the page body stays one Telegram message however many reads FAIL", lambda: len(many) <= BODY_MAX_CHARS)

    # ── the artifacts this suite's seams replace, asserted where they are installed ──
    # The stubs above stand in for send_telegram.sh and the registry; these read the REAL siblings
    # (present beside this file in the repo and in /opt/algovault-monitoring/), so a drifted wrapper
    # grammar, an unregistered alert id or an unexecutable registry is red here, not at 06:27.
    def sibling(name):
        with open(os.path.join(HERE, name), encoding="utf-8") as fh:
            return fh.read()

    def wrapper_key_re():
        m = re.search(r'^KEY_RE = re\.compile\(r"(.+)"\)$', sibling("send_telegram.sh"), re.M)
        return m.group(1) if m else None
    check("this file's WRAPPER_KEY_RE is send_telegram.sh's own KEY_RE, byte for byte",
          lambda: wrapper_key_re() == WRAPPER_KEY_RE.pattern)

    def registry_row():
        rows = [a for a in json.loads(sibling("alert-registry.json"))["alerts"] if a.get("alert_id") == ALERT_ID]
        return rows[0] if len(rows) == 1 else None
    check("alert-registry.json declares OWED_READ_FAIL exactly once, page_on change, owned by this file",
          lambda: (registry_row() or {}).get("page_on") == "change"
          and (registry_row() or {}).get("owner") == "ops/monitoring/owed-read-runner.py")

    def installed_registry_ok():
        reads, err = load_registry(os.path.join(HERE, "owed-reads.json"))
        return err is None and all(r is not None and os.path.isfile(os.path.join(HERE, r["script"]))
                                   for r, _, _ in validate_registry(reads))
    check("the registry beside this file is valid and every row's script is installed beside it",
          installed_registry_ok)

    n = len(ran)
    ok = not failures and n >= _SELF_TEST_MIN_CHECKS
    if n < _SELF_TEST_MIN_CHECKS:
        print("  [FAIL] VACUITY: %d check(s) ran, floor is %d" % (n, _SELF_TEST_MIN_CHECKS))
    print("SELF-TEST: %s (%d check(s) ran, floor %d, %d failure(s))"
          % ("PASS" if ok else "FAIL", n, _SELF_TEST_MIN_CHECKS, len(failures)))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""GROWTH-AGENT-SIGNIN-STEPUP-W1-V2 R2.6 — `stepup-readout`, the daily record the move to N is ruled on.

Host-side (signal-1, /opt/algovault-monitoring/), root cron, once a day. It answers the questions the
CH4 ruling packet asks, from production data, and writes ONE structured line to `canary-results.jsonl`
(`canary_result_log.append_result`), which `monitoring-results-sync.sh` pulls into the vault:

  * free-tier metered calls for the last complete UTC day, by POOL (Anthropic egress vs other) and
    CLIENT FAMILY, with distinct ip BUCKETS beside them — buckets, labelled as buckets: `request_log`
    carries no key or identity column, so a bucket is the finest unit this instrument can see (M7);
  * `stepup_would_gate` (shadow) / `stepup_gated` (live) events for that day, by family and pool;
  * `quota_hit_block` events for that day, by session pool;
  * Anthropic-egress metered calls over the trailing 30 d — the number `CLAUDE_POOL=EMPTY` is ruled
    on — and `OAUTH_TRIGGER=MET|NOT_MET` at >= 1,000 (the deferred OAuth wave's measured trigger);
  * the ACTIVATION GUARD: per client family, successful metered calls in the last 7 complete UTC days
    against the 7 before. A family that had >= 200 calls in the prior week and dropped >= 30 % is a
    BREACH. The guard measures CALLS, never sessions or buckets: the Claude pool collapses to <= 8
    buckets whatever happens.

ARMED ONLY IN `live`, REPORTED IN EVERY MODE. A breach is recorded in every run's record, but it
PAGES (`STEPUP_ACTIVATION_DROP`, CRITICAL_PERSISTENT, the wrapper's 24 h cooldown) only when the
resolved STEPUP_MODE is `live` — the only mode in which the step-up changes what a caller receives.
Measured before install (dry run on signal-1, 2026-10-12, mode off, nothing changed for anyone):
`node` 1,190 → 555 (−53 %) and `python-httpx` 459 → 7 (−98.5 %) week over week. Script traffic is
lumpy — a handful of heavy callers come and go — so an always-armed guard would page on organic
churn from its first night and be muted within a week. In `shadow` the records ARE the calibration
the CH4 ruling reads: seven days of week-over-week family volume with zero user impact.

ONE DERIVATION, RESOLVED IN THE RUNNING IMAGE. Pool membership (set A = `hashIp` of the eight masked
/24 network addresses of 160.79.104.0/21), the metered predicate (`call-class.ts` `billablePredicate()`)
and the step-up mode + N (`plans.ts` `resolveStepupMode()` / `FREE_KEYLESS_MONTHLY_CALLS_RULED`) are
all computed by a `node -e` probe INSIDE the app container from its deployed `dist/` — never mirrored
here. The ip-hash key never leaves the container; the probe returns SQL, and psql (`aoe_readonly`,
read-only transaction) returns aggregates only — no ip hash, key or session id is printed or stored.

Verdict token: exactly one terminal `STEPUP_READOUT_VERDICT=PASS|FAIL|INDETERMINATE`.
  PASS          record written, every family evaluated, nothing paged (in off/shadow a breach is
                REPORTED in the record and the log, never paged)                    → exit 0
  FAIL          `live`, and an activation breach was handed to the wrapper          → exit 0
                (a paging canary must not also mail cron; the TOKEN carries the verdict)
  INDETERMINATE the probe or the query could not be evaluated — nothing was judged → exit 3
A failed record append never changes the verdict; it prints `CANARY_RESULT_LOG_FAILED=` instead of
`CANARY_RESULT_LOG=`, so a run that wrote nothing never looks like one that did.

Usage:
  stepup-readout.py                 # the scheduled run
  stepup-readout.py --self-test     # hermetic: no docker, no psql, no wrapper, no result file
Env: TG_WRAPPER · STEPUP_READOUT_LOG · ALGOVAULT_TG_TEST_INERT=1 (wrapper: no POST, no marker).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ALERT_ID = "STEPUP_ACTIVATION_DROP"
CANARY = "stepup-readout"
APP_CONTAINER = "crypto-quant-signal-mcp-mcp-server-1"
PG_CONTAINER = "crypto-quant-signal-mcp-postgres-1"
PG_ROLE = "aoe_readonly"
PG_DB = "signal_performance"
WRAPPER = os.environ.get("TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
LOG = os.environ.get("STEPUP_READOUT_LOG", "/var/log/algovault-stepup-readout.log")

GUARD_MIN_PRIOR_WEEK = 200      # a family below this prior-week volume is reported, never paged
GUARD_DROP = 0.30               # >= 30 % week-over-week drop pages
OAUTH_TRIGGER_CALLS = 1000      # Anthropic-egress metered calls, trailing 30 d (V2 R-6)
TOP_FAMILIES = 12               # bounds the record under canary_result_log's 8 KiB line cap

LAST_FIRE: dict = {}
LAST_CLEAR: dict = {}
LAST_RECORD: list = []

# The probe runs INSIDE the app container. It prints ONE JSON object {mode, n, d0, d1, sql}.
# `sql` is a set of labelled SELECTs whose rows are `label|a|b|c|d`; nothing in it is printed.
PROBE_JS = r"""
const { hashIp } = require('/app/dist/lib/analytics.js');
const { billablePredicate } = require('/app/dist/lib/call-class.js');
const plans = require('/app/dist/lib/plans.js');
const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
const DAY = 86400e3;
const now = Date.now();
const d1 = new Date(Math.floor(now / DAY) * DAY);          // today 00:00Z — the last complete day ends here
const D1 = d1.toISOString();
const D0 = new Date(d1.getTime() - DAY).toISOString();    // yesterday 00:00Z
const W7 = new Date(d1.getTime() - 7 * DAY).toISOString();
const W14 = new Date(d1.getTime() - 14 * DAY).toISOString();
const W30 = new Date(now - 30 * DAY).toISOString();
const A = [];
for (let i = 104; i <= 111; i++) A.push(hashIp('160.79.' + i + '.0'));
const p = billablePredicate();
let k = 0;
const BILL = p.sql.replace(/\?/g, () => q(p.params[k++]));
const IN_A = '(' + A.map(q).join(',') + ')';
const FREE = "license_tier = 'free' AND coalesce(is_bot_internal, false) = false AND " + BILL;
const pool = (col) => 'CASE WHEN ' + col + ' IN ' + IN_A + " THEN 'anthropic' ELSE 'other' END";
const sql = [
  "SELECT 'calls_1d', " + pool('ip_hash') + ", coalesce(client_name, '<null>'), count(*), count(DISTINCT ip_hash) FROM request_log WHERE " + FREE +
    ' AND "timestamp" >= ' + q(D0) + ' AND "timestamp" < ' + q(D1) + ' GROUP BY 2, 3;',
  "SELECT 'anthropic_30d', count(*), count(DISTINCT ip_hash), '', '' FROM request_log WHERE " + FREE +
    ' AND "timestamp" >= ' + q(W30) + ' AND ip_hash IN ' + IN_A + ';',
  "SELECT 'stepup_1d', event_type, coalesce(meta_json::jsonb->>'client_family', '<null>'), " +
    pool("substr(meta_json::jsonb->>'bucket', 6)") + ", count(*) FROM funnel_events WHERE event_type IN ('stepup_would_gate', 'stepup_gated') AND ts >= " +
    q(D0) + '::timestamptz AND ts < ' + q(D1) + '::timestamptz GROUP BY 2, 3, 4;',
  "SELECT 'qhb_1d', " + pool('session_id') + ", count(*), count(DISTINCT session_id), '' FROM funnel_events WHERE event_type = 'quota_hit_block' AND ts >= " +
    q(D0) + '::timestamptz AND ts < ' + q(D1) + '::timestamptz GROUP BY 2;',
  "SELECT 'act', coalesce(client_name, '<null>'), count(*) FILTER (WHERE \"timestamp\" >= " + q(W7) + '), count(*) FILTER (WHERE "timestamp" < ' + q(W7) +
    '), count(DISTINCT ip_hash) FILTER (WHERE "timestamp" >= ' + q(W7) + ') FROM request_log WHERE ' + FREE +
    ' AND "timestamp" >= ' + q(W14) + ' AND "timestamp" < ' + q(D1) + ' GROUP BY 2;',
].join('\n');
process.stdout.write(JSON.stringify({ mode: plans.resolveStepupMode(process.env), n: plans.FREE_KEYLESS_MONTHLY_CALLS_RULED, d0: D0, d1: D1, sql }));
"""


def _fd_is_file(fd: int, path: str) -> bool:
    """True when file descriptor `fd` IS `path` (same device + inode)."""
    try:
        a, b = os.fstat(fd), os.stat(path)
        return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)
    except (OSError, ValueError):
        return False


def log(msg: str) -> None:
    """Print, and append to LOG — unless stdout already IS the log, or this is the self-test.

    The cron line appends stdout to LOG, so appending here as well wrote every line TWICE (measured
    on the first cron-faithful run, 2026-10-12T08:28:56Z). Same class, same fix as the sibling
    client-claim-freshness.py: detected by inode, not an env flag, so a manual run still logs. The
    self-test prints only — its fixture rows read as live activation data in the production log
    (same day, 08:28:46Z)."""
    line = "%s %s" % (datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), msg)
    print(line, flush=True)
    if _selftest_mode():
        return
    try:
        stdout_fd = sys.stdout.fileno()
    except (AttributeError, OSError, ValueError):
        stdout_fd = -1
    if stdout_fd >= 0 and _fd_is_file(stdout_fd, LOG):
        return
    try:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass  # the log is evidence, not the contract; the token is the contract


# ── pure logic (fixture-drivable — what --self-test exercises) ──────────────────────────────────


def _int(s: str) -> int:
    try:
        return int(str(s).strip())
    except (TypeError, ValueError):
        return 0


def parse_rows(text: str) -> dict:
    """psql `-tA -F|` output → structured aggregates. Unknown labels are ignored, never fatal."""
    out = {"calls_1d": [], "anthropic_30d": {"calls": 0, "buckets": 0}, "stepup_1d": [], "qhb_1d": [], "act": []}
    for line in text.splitlines():
        parts = line.split("|")
        if len(parts) < 2:
            continue
        label = parts[0]
        if label == "calls_1d" and len(parts) >= 5:
            out["calls_1d"].append({"pool": parts[1], "family": parts[2], "calls": _int(parts[3]), "buckets": _int(parts[4])})
        elif label == "anthropic_30d" and len(parts) >= 3:
            out["anthropic_30d"] = {"calls": _int(parts[1]), "buckets": _int(parts[2])}
        elif label == "stepup_1d" and len(parts) >= 5:
            out["stepup_1d"].append({"event": parts[1], "family": parts[2], "pool": parts[3], "count": _int(parts[4])})
        elif label == "qhb_1d" and len(parts) >= 4:
            out["qhb_1d"].append({"pool": parts[1], "events": _int(parts[2]), "sessions": _int(parts[3])})
        elif label == "act" and len(parts) >= 5:
            out["act"].append({"family": parts[1], "cur7": _int(parts[2]), "prev7": _int(parts[3]), "buckets7": _int(parts[4])})
    return out


def evaluate_guard(act: list[dict]) -> list[dict]:
    """Every family, judged. A breach needs >= GUARD_MIN_PRIOR_WEEK prior-week calls AND a drop of
    >= GUARD_DROP. Below the floor a family is REPORTED (`below_floor`), never paged — a small base
    makes a 30 % swing noise, not signal."""
    judged = []
    for row in sorted(act, key=lambda r: -r["prev7"]):
        prev, cur = row["prev7"], row["cur7"]
        drop = (prev - cur) / prev if prev > 0 else 0.0  # ratio-exempt: week-over-week change of ONE measure (one statement, one FROM/WHERE, two adjacent 7-day FILTER windows) — a signed delta, not an event rate over a population
        if prev < GUARD_MIN_PRIOR_WEEK:
            state = "below_floor"
        elif drop >= GUARD_DROP:
            state = "breach"
        else:
            state = "ok"
        judged.append({**row, "drop_pct": round(drop * 100, 1), "state": state})
    return judged


def build_metrics(probe: dict, rows: dict, judged: list[dict]) -> dict:
    """The record body. Compact on purpose: canary_result_log refuses a line over 8 KiB."""
    by_pool: dict = {}
    for r in rows["calls_1d"]:
        p = by_pool.setdefault(r["pool"], {"calls": 0, "buckets": 0, "families": {}})
        p["calls"] += r["calls"]
        p["buckets"] += r["buckets"]
        p["families"][r["family"]] = r["calls"]
    for p in by_pool.values():
        top = sorted(p["families"].items(), key=lambda kv: -kv[1])[:TOP_FAMILIES]
        p["families"] = dict(top)
    a30 = rows["anthropic_30d"]
    return {
        "mode": probe.get("mode"),
        "n_ruled": probe.get("n"),
        "day": (probe.get("d0") or "")[:10],
        "free_metered_1d": by_pool,
        "stepup_events_1d": rows["stepup_1d"][:TOP_FAMILIES * 2],
        "quota_hit_block_1d": rows["qhb_1d"],
        "anthropic_calls_30d": a30["calls"],
        "anthropic_buckets_30d": a30["buckets"],
        "oauth_trigger": "MET" if a30["calls"] >= OAUTH_TRIGGER_CALLS else "NOT_MET",
        "activation": [
            {k: j[k] for k in ("family", "prev7", "cur7", "drop_pct", "state", "buckets7")}
            for j in judged[:TOP_FAMILIES]
        ],
        "activation_breaches": sum(1 for j in judged if j["state"] == "breach"),
        "guard_armed": probe.get("mode") == "live",
        "units": "calls; buckets are distinct ip buckets, not people (request_log has no identity column)",
    }


def should_page(mode: str) -> bool:
    """The guard is ARMED only in `live` — the only mode in which the step-up changes what a caller
    receives. In off/shadow a breach is organic churn by construction, so it is reported, not paged."""
    return mode == "live"


def build_body(judged: list[dict]) -> str:
    """Operator-facing body. Entity nouns on every id ('client family node'), never a bare number."""
    breaches = [j for j in judged if j["state"] == "breach"]
    lines = ["\U0001F6D1 %s" % ALERT_ID, ""]
    noun = "client family" if len(breaches) == 1 else "client families"
    lines.append("Free-tier metered calls fell %d%%+ week over week for %d %s:" % (int(GUARD_DROP * 100), len(breaches), noun))
    for j in breaches:
        lines.append("• client family %s: %d → %d calls/week (−%s %%), %d bucket(s) this week"
                     % (j["family"], j["prev7"], j["cur7"], j["drop_pct"], j["buckets7"]))
    lines += ["", "Read the daily stepup-readout records (vault Claude files/canary-results.jsonl) beside the",
              "STEPUP_MODE in force. Rollback lever: STEPUP_MODE=shadow|off through an interlocked recreate.",
              "Action: dispatch OPS-STEPUP-ACTIVATION-W{NEXT}"]
    return "\n".join(lines)


# ── effects ───────────────────────────────────────────────────────────────────────────────────────


def _selftest_mode() -> bool:
    return os.environ.get("STEPUP_READOUT_SELFTEST") == "1"


def fire(body: str) -> None:
    LAST_FIRE[ALERT_ID] = body
    if _selftest_mode():
        log("WOULD_FIRE: %s (self-test — wrapper skipped)" % ALERT_ID)
        return
    proc = subprocess.run([WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"],
                          input=body, capture_output=True, text=True, timeout=30)
    log("wrapper exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


def clear(reason: str) -> None:
    LAST_CLEAR[ALERT_ID] = reason
    if _selftest_mode():
        log("WOULD_CLEAR: %s (self-test — wrapper skipped)" % ALERT_ID)
        return
    with open(os.devnull, "rb") as devnull:
        proc = subprocess.run([WRAPPER, "--clear", ALERT_ID, reason],
                              stdin=devnull, capture_output=True, text=True, timeout=30)
    log("wrapper --clear exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


def run_probe() -> dict:
    proc = subprocess.run(["docker", "exec", APP_CONTAINER, "node", "-e", PROBE_JS],
                          capture_output=True, text=True, timeout=90)
    if proc.returncode != 0:
        raise RuntimeError("probe exit %d: %s" % (proc.returncode, (proc.stderr or "").strip()[:200]))
    probe = json.loads(proc.stdout)
    for key in ("mode", "n", "d0", "d1", "sql"):
        if key not in probe:
            raise RuntimeError("probe output lacks %r" % key)
    if probe["mode"] not in ("off", "shadow", "live"):
        raise RuntimeError("probe mode %r is not a resolved mode" % probe["mode"])
    return probe


def run_sql(sql: str) -> str:
    proc = subprocess.run(
        ["docker", "exec", "-i", "-e", "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=60000",
         PG_CONTAINER, "psql", "-U", PG_ROLE, "-d", PG_DB, "-tA", "-F", "|", "-q", "-v", "ON_ERROR_STOP=1"],
        input=sql, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError("psql exit %d: %s" % (proc.returncode, (proc.stderr or "").strip()[:200]))
    return proc.stdout


def record(verdict: str, exit_code: int, metrics: dict) -> None:
    if _selftest_mode():
        LAST_RECORD[:] = [verdict, exit_code, metrics]
        print("CANARY_RESULT_LOG=selftest-skipped", flush=True)
        return
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import canary_result_log  # noqa: E402 — lives beside this file on the host
        ok, detail = canary_result_log.append_result(CANARY, verdict, exit_code, metrics)
    except Exception as e:  # noqa: BLE001 — a recorder failure must never change the verdict
        ok, detail = False, "import/append raised: %s" % str(e)[:160]
    print("CANARY_RESULT_LOG=%s" % detail if ok else "CANARY_RESULT_LOG_FAILED=%s" % detail, flush=True)


def finish(verdict: str, code: int) -> int:
    print("STEPUP_READOUT_VERDICT=%s" % verdict, flush=True)
    return code


def main() -> int:
    try:
        probe = run_probe()
        rows = parse_rows(run_sql(probe["sql"]))
    except Exception as e:  # noqa: BLE001 — could not evaluate: INDETERMINATE, never a default
        log("INDETERMINATE: %s" % str(e)[:240])
        record("INDETERMINATE", 3, {"reason": str(e)[:200]})
        return finish("INDETERMINATE", 3)
    judged = evaluate_guard(rows["act"])
    metrics = build_metrics(probe, rows, judged)
    for j in judged:
        log("ACTIVATION family=%s prev7=%d cur7=%d drop_pct=%s state=%s"
            % (j["family"], j["prev7"], j["cur7"], j["drop_pct"], j["state"]))
    log("POOLS %s" % json.dumps(metrics["free_metered_1d"], separators=(",", ":"))[:600])
    log("OAUTH_TRIGGER=%s anthropic_calls_30d=%d" % (metrics["oauth_trigger"], metrics["anthropic_calls_30d"]))
    breaches = [j for j in judged if j["state"] == "breach"]
    if breaches and should_page(probe["mode"]):
        fire(build_body(judged))
        record("FAIL", 0, metrics)
        return finish("FAIL", 0)
    if breaches:
        log("ACTIVATION_BREACH_REPORTED=%d (mode=%s — the guard pages only in live)" % (len(breaches), probe["mode"]))
    clear("no paged activation breach (mode=%s)" % probe["mode"])
    record("PASS", 0, metrics)
    return finish("PASS", 0)


# ── self-test ─────────────────────────────────────────────────────────────────────────────────────


def _selftest_log(check) -> None:
    """log() against a temp LOG: the self-test never appends, a manual run appends once, and a run
    whose stdout IS the log (the cron redirect) leaves one copy, not two."""
    import shutil
    import tempfile
    global LOG
    saved_log, saved_env = LOG, os.environ.get("STEPUP_READOUT_SELFTEST")
    tmpd = tempfile.mkdtemp(prefix="stepup-log-")
    try:
        LOG = os.path.join(tmpd, "a.log")
        log("selftest-line")
        check("log: the self-test never appends to the production log",
              not os.path.exists(LOG) or os.path.getsize(LOG) == 0)
        os.environ["STEPUP_READOUT_SELFTEST"] = "0"
        log("manual-line")
        check("log: a run whose stdout is NOT the log appends exactly once",
              open(LOG, encoding="utf-8").read().count("manual-line") == 1)
        LOG = os.path.join(tmpd, "b.log")
        with open(LOG, "a", encoding="utf-8") as fh:
            real = sys.stdout
            sys.stdout = fh
            try:
                log("cron-line")
            finally:
                sys.stdout = real
        check("log: stdout already IS the log (the cron redirect) → one copy, not two",
              open(LOG, encoding="utf-8").read().count("cron-line") == 1)
    finally:
        LOG = saved_log
        os.environ["STEPUP_READOUT_SELFTEST"] = saved_env if saved_env is not None else "1"
        shutil.rmtree(tmpd, ignore_errors=True)


def self_test() -> int:
    os.environ["STEPUP_READOUT_SELFTEST"] = "1"
    fails = []
    ran = 0

    def check(name, fn):
        nonlocal ran
        ran += 1
        try:
            ok = bool(fn() if callable(fn) else fn)
        except Exception as e:  # noqa: BLE001 — an assertion that raises is reported, not crashed
            ok = False
            name = "%s (raised %s)" % (name, e)
        print("  %s %s" % ("PASS" if ok else "FAIL", name))
        if not ok:
            fails.append(name)

    fixture = "\n".join([
        "calls_1d|other|python-requests|300|4",
        "calls_1d|other|node|120|30",
        "calls_1d|anthropic|claude|5|1",
        "anthropic_30d|64|1||",
        "stepup_1d|stepup_would_gate|node|other|3",
        "qhb_1d|other|1200|3|",
        "act|python-requests|900|1500|5",   # −40 % from 1,500 → breach
        "act|node|700|800|90",              # −12.5 % → ok
        "act|claude|10|60|1",               # −83 % but prior week 60 < 200 → below_floor
        "act|mcp-sdk|140|200|4",            # exactly −30 % from exactly 200 → breach (inclusive)
        "garbage line",
        "unknown_label|1|2|3|4",
    ])
    rows = parse_rows(fixture)
    check("parse: every labelled row lands in its bucket",
          len(rows["calls_1d"]) == 3 and rows["anthropic_30d"] == {"calls": 64, "buckets": 1}
          and len(rows["stepup_1d"]) == 1 and len(rows["qhb_1d"]) == 1 and len(rows["act"]) == 4)
    judged = evaluate_guard(rows["act"])
    state = {j["family"]: j["state"] for j in judged}
    check("guard: −40 % on 1,500 is a breach", state["python-requests"] == "breach")
    check("guard: −12.5 % is ok", state["node"] == "ok")
    check("guard: a big drop below the 200 floor is reported, never paged", state["claude"] == "below_floor")
    check("guard: the boundary (200 prior, −30 %) is inclusive", state["mcp-sdk"] == "breach")
    check("guard: a growing family is ok", evaluate_guard([{"family": "x", "cur7": 500, "prev7": 300, "buckets7": 1}])[0]["state"] == "ok")
    check("guard: zero prior week never divides by zero", evaluate_guard([{"family": "x", "cur7": 5, "prev7": 0, "buckets7": 1}])[0]["state"] == "below_floor")
    probe = {"mode": "shadow", "n": 50, "d0": "2026-10-12T00:00:00.000Z", "d1": "2026-10-13T00:00:00.000Z", "sql": ""}
    metrics = build_metrics(probe, rows, judged)
    check("metrics: pools aggregate calls and buckets", metrics["free_metered_1d"]["other"]["calls"] == 420
          and metrics["free_metered_1d"]["anthropic"]["buckets"] == 1)
    check("metrics: OAUTH_TRIGGER is NOT_MET below 1,000", metrics["oauth_trigger"] == "NOT_MET")
    rows_met = parse_rows("anthropic_30d|1000|3||")
    check("metrics: OAUTH_TRIGGER is MET at exactly 1,000",
          build_metrics(probe, rows_met, [])["oauth_trigger"] == "MET")
    check("metrics: breaches counted", metrics["activation_breaches"] == 2)
    check("metrics: fits canary_result_log's 8 KiB line cap",
          len(json.dumps(metrics, separators=(",", ":"))) < 7000)
    big = parse_rows("\n".join("calls_1d|other|fam%d|%d|1" % (i, i) for i in range(500)))
    check("metrics: 500 families still fit (top-N bound)",
          len(json.dumps(build_metrics(probe, big, []), separators=(",", ":"))) < 7000)
    body = build_body(judged)
    check("body: names the alert id and the entity noun", ALERT_ID in body and "client family python-requests" in body)
    check("body: renders prior and current week numbers", "1500 → 900 calls/week" in body)
    check("body: a below-floor family is not paged", "client family claude" not in body)
    check("body: carries a templated Action line, never a literal wave number", "OPS-STEPUP-ACTIVATION-W{NEXT}" in body)
    # The bypassed artifacts: the probe and the psql invocation are the only code no scenario runs,
    # so their SHAPE is asserted here (a hermetic self-test is blind to exactly what its seam replaces).
    check("probe: derives set A with the app's own hashIp", "require('/app/dist/lib/analytics.js')" in PROBE_JS and "hashIp('160.79.' + i + '.0')" in PROBE_JS)
    check("probe: the metered predicate is the app's billablePredicate()", "billablePredicate()" in PROBE_JS)
    check("probe: mode and N come from the deployed plans module", "plans.resolveStepupMode(process.env)" in PROBE_JS and "FREE_KEYLESS_MONTHLY_CALLS_RULED" in PROBE_JS)
    check("probe: covers addresses .104 through .111 (the /21)", "i <= 111" in PROBE_JS and "i = 104" in PROBE_JS)
    check("probe: never prints a hash — only mode, n, bounds and the SQL go to stdout",
          PROBE_JS.count("process.stdout.write") == 1 and "JSON.stringify({ mode:" in PROBE_JS)
    check("alert id is a module-level literal (visible to check-alert-registry)", ALERT_ID == "STEPUP_ACTIVATION_DROP")
    check("guard: armed only in live", should_page("live") and not should_page("shadow") and not should_page("off"))
    check("metrics: records whether the guard was armed", metrics["guard_armed"] is False
          and build_metrics({**probe, "mode": "live"}, rows, judged)["guard_armed"] is True)
    fire(body)
    check("fire in self-test skips the wrapper and records the body", LAST_FIRE.get(ALERT_ID) == body)
    clear("ok")
    check("clear in self-test skips the wrapper", LAST_CLEAR.get(ALERT_ID) == "ok")
    # The decision path end to end, through main(), with the two effects that reach production
    # (the in-container probe and psql) replaced by fixtures. Without this leg the scenario suite
    # never executes main() — the one function that turns a breach into a page.
    g = globals()
    real_probe, real_sql = g["run_probe"], g["run_sql"]
    try:
        for mode, want in (("shadow", "PASS"), ("off", "PASS"), ("live", "FAIL")):
            LAST_FIRE.clear(); LAST_RECORD.clear()
            g["run_probe"] = lambda m=mode: {"mode": m, "n": 20, "d0": "2026-10-12T00:00:00.000Z", "d1": "2026-10-13T00:00:00.000Z", "sql": "-"}
            g["run_sql"] = lambda _sql: fixture
            main()
            check("main(): a breach in %s → %s%s" % (mode, want, " (paged)" if want == "FAIL" else " (reported, not paged)"),
                  LAST_RECORD[:1] == [want] and (ALERT_ID in LAST_FIRE) == (want == "FAIL"))
        LAST_FIRE.clear(); LAST_RECORD.clear()
        g["run_probe"] = lambda: (_ for _ in ()).throw(RuntimeError("docker exec failed"))
        rc = main()
        check("main(): an unreadable probe is INDETERMINATE, exit 3, and pages nothing",
              rc == 3 and LAST_RECORD[:1] == ["INDETERMINATE"] and not LAST_FIRE)
    finally:
        g["run_probe"], g["run_sql"] = real_probe, real_sql
    _selftest_log(check)
    if ran == 0:
        print("SELF-TEST: FAIL (vacuous — no scenario ran)")
        return 1
    if fails:
        print("SELF-TEST: FAIL (%d of %d)" % (len(fails), ran))
        return 1
    print("SELF-TEST: PASS (%d checks)" % ran)
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        sys.exit(self_test())
    sys.exit(main())

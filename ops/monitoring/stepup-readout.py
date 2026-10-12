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
  * the ACTIVATION GUARD (Mr.1's CH4 ruling, Q1 = C amended): per client family, weekly
    ACTIVATIONS — buckets whose FIRST-EVER successful free metered call (v2-tagged ip_hash) fell in
    that 7-day window — for the last complete week against the one before. It PAGES only at
    STEPUP_MODE=live, and only when ALL hold: the prior week had >= ACT_MIN_PRIOR_WEEK (5)
    activating buckets, the drop is >= GUARD_DROP (30 %), and the drop is LARGER than that family's
    largest weekly drop over the 6 pre-flip weeks — the ENVELOPE, computed from request_log once, at
    flip time (`--freeze-envelope`), and frozen in ENVELOPE_PATH. Why activations and not calls: at
    N = 20 call volume falls BY DESIGN (Aug/Sep had 4,754–8,348 calls a month above N), while a
    caller's first success is exactly what the step-up must not break.
  * call VOLUME per family (last 7 complete days vs the 7 before) stays in every record — REPORTED,
    NEVER PAGED. Measured before install (2026-10-12, mode off, nothing changed for anyone): `node`
    1,190 → 555 (−53 %) and `python-httpx` 459 → 7 (−98.5 %) week over week, which is why volume
    was never a sound alarm.

ARMED ONLY IN `live`, REPORTED IN EVERY MODE. The activation states are computed and recorded in
every run, but the page fires only when the resolved STEPUP_MODE is `live` — the only mode in which
the step-up changes what a caller receives. In `live` with no readable frozen envelope the guard
cannot decide, so the run is INDETERMINATE (exit 3), never a quiet PASS.

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

GUARD_DROP = 0.30               # >= 30 % week-over-week drop in ACTIVATIONS (and beyond the envelope) pages
ACT_MIN_PRIOR_WEEK = 5          # a family needs >= 5 activating buckets in the prior week to page
ENVELOPE_WEEKS = 6              # the envelope = the largest of the 6 pre-flip weekly drops (7 weeks of counts)
ENVELOPE_PATH = os.environ.get("STEPUP_ENVELOPE_PATH", "/var/lib/algovault-monitoring/stepup-activation-envelope.json")
OAUTH_TRIGGER_CALLS = 1000      # Anthropic-egress metered calls, trailing 30 d (V2 R-6)
TOP_FAMILIES = 12               # bounds the record under canary_result_log's 8 KiB line cap

LAST_FIRE: dict = {}
LAST_CLEAR: dict = {}
LAST_RECORD: list = []

# The probe runs INSIDE the app container. It prints ONE JSON object {mode, n, d0, d1, ref, weeks, sql}.
# The activation windows end at REF: today 00:00Z for the daily run, or the flip's UTC day for
# `--freeze-envelope` (STEPUP_REF_ISO); WEEKS windows back, j = 0 the most recent. The `actw` SELECT
# takes each v2 bucket's FIRST successful free metered call (DISTINCT ON keeps the earliest row), its
# family, and the 7-day window before REF it fell in; only aggregates leave psql. (No `//` comments
# inside PROBE_JS: the ops-surface guards strip them as comments, and they are string CONTENT here.)
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
const REF = process.env.STEPUP_REF_ISO ? new Date(Math.floor(Date.parse(process.env.STEPUP_REF_ISO) / DAY) * DAY) : d1;
const RISO = REF.toISOString();
const WEEKS = Math.max(2, Math.min(12, parseInt(process.env.STEPUP_WEEKS || '2', 10) || 2));
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
  "SELECT 'actw', family, wk, count(*), '' FROM (SELECT DISTINCT ON (ip_hash) ip_hash, coalesce(client_name, '<null>') AS family, " +
    'floor(extract(epoch FROM (' + q(RISO) + '::timestamptz - "timestamp"::timestamptz)) / 604800)::int AS wk FROM request_log WHERE ' + FREE +
    " AND ip_hash LIKE 'v2:%' AND \"timestamp\" < " + q(RISO) + ' ORDER BY ip_hash, "timestamp") f WHERE wk < ' + WEEKS + ' GROUP BY 2, 3;',
].join('\n');
process.stdout.write(JSON.stringify({ mode: plans.resolveStepupMode(process.env), n: plans.FREE_KEYLESS_MONTHLY_CALLS_RULED, d0: D0, d1: D1, ref: RISO, weeks: WEEKS, sql }));
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
    out = {"calls_1d": [], "anthropic_30d": {"calls": 0, "buckets": 0}, "stepup_1d": [], "qhb_1d": [], "act": [], "actw": []}
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
        elif label == "actw" and len(parts) >= 4:
            out["actw"].append({"family": parts[1], "wk": _int(parts[2]), "n": _int(parts[3])})
    return out


def evaluate_volume(act: list[dict]) -> list[dict]:
    """Call volume per family, last 7 complete days vs the 7 before. REPORTED, NEVER PAGED (Q1)."""
    out = []
    for row in sorted(act, key=lambda r: -r["prev7"]):
        prev, cur = row["prev7"], row["cur7"]
        drop = (prev - cur) / prev if prev > 0 else 0.0  # ratio-exempt: week-over-week change of ONE measure (one statement, one FROM/WHERE, two adjacent 7-day FILTER windows) — a signed delta, not an event rate over a population
        out.append({**row, "drop_pct": round(drop * 100, 1)})
    return out


def week_drop(prev: int, cur: int):
    """(prev - cur) / prev, or None when there was no prior week to fall from."""
    return (prev - cur) / prev if prev > 0 else None  # ratio-exempt: week-over-week change of ONE measure (one family's activating buckets in two adjacent 7-day windows of one statement) — a signed delta, not an event rate over a population


def weekly_by_family(actw: list[dict], weeks: int) -> dict:
    """{family: [A_0, …, A_(weeks-1)]}: A_j = buckets whose FIRST successful free metered call fell in
    the j-th 7-day window before the reference instant (j = 0 the most recent)."""
    out: dict = {}
    for r in actw:
        if 0 <= r["wk"] < weeks:
            out.setdefault(r["family"], [0] * weeks)[r["wk"]] += r["n"]
    return out


def compute_envelope(weekly: dict) -> dict:
    """Per family: the 7 pre-flip weekly counts, the 6 weekly drops (week j against week j+1; None
    where week j+1 had no activations) and their MAXIMUM — the envelope a live drop must exceed."""
    fams = {}
    for fam, a in weekly.items():
        a = (list(a) + [0] * (ENVELOPE_WEEKS + 1))[:ENVELOPE_WEEKS + 1]
        drops = [week_drop(a[j + 1], a[j]) for j in range(ENVELOPE_WEEKS)]
        defined = [d for d in drops if d is not None]
        fams[fam] = {
            "weekly": a,
            "drops_pct": [None if d is None else round(d * 100, 1) for d in drops],
            "envelope_pct": round(max(defined) * 100, 1) if defined else None,
        }
    return fams


def evaluate_activation(weekly2: dict, envelope_fams) -> list[dict]:
    """Every family judged, in the order of its prior-week activations. States, in order:
    below_floor (prior < ACT_MIN_PRIOR_WEEK) · ok (drop < GUARD_DROP, or growth) · no_envelope (the
    family has no defined pre-flip drop — UNDEFINED, never a page) · within_envelope (drop <= the
    envelope) · breach. A breach pages only in live (should_page)."""
    env = envelope_fams or {}
    judged = []
    for fam in set(weekly2) | set(env):
        a = weekly2.get(fam, [0, 0])
        cur, prev = a[0], a[1]
        d = week_drop(prev, cur)
        drop_pct = None if d is None else round(d * 100, 1)
        env_pct = (env.get(fam) or {}).get("envelope_pct")
        if prev < ACT_MIN_PRIOR_WEEK:
            state = "below_floor"
        elif d is None or d < GUARD_DROP:
            state = "ok"
        elif env_pct is None:
            state = "no_envelope"
        elif drop_pct <= env_pct:
            state = "within_envelope"
        else:
            state = "breach"
        judged.append({"family": fam, "prev_w": prev, "cur_w": cur, "drop_pct": drop_pct,
                       "envelope_pct": env_pct, "state": state})
    judged.sort(key=lambda j: (-j["prev_w"], j["family"]))
    return judged


def load_envelope(path=None):
    """(document, None) for a readable frozen envelope, else (None, reason)."""
    target = path or ENVELOPE_PATH
    try:
        doc = json.loads(Path(target).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, "absent at %s" % target
    except (OSError, ValueError) as e:
        return None, "unreadable: %s" % str(e)[:120]
    if not isinstance(doc, dict) or not isinstance(doc.get("families"), dict) or not doc.get("reference_day"):
        return None, "malformed (no families / reference_day)"
    return doc, None


def build_metrics(probe: dict, rows: dict, judged: list[dict], volume=None, envelope=None, envelope_reason=None) -> dict:
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
            {k: j[k] for k in ("family", "prev_w", "cur_w", "drop_pct", "envelope_pct", "state")}
            for j in judged[:TOP_FAMILIES]
        ],
        "activation_breaches": sum(1 for j in judged if j["state"] == "breach"),
        "envelope": ({"reference_day": envelope.get("reference_day"), "frozen_at": envelope.get("computed_at")}
                     if envelope else {"state": envelope_reason or "absent"}),
        "volume": [
            {k: v[k] for k in ("family", "prev7", "cur7", "drop_pct", "buckets7")}
            for v in (volume or [])[:TOP_FAMILIES]
        ],
        "guard_armed": probe.get("mode") == "live",
        "units": "activation = buckets whose FIRST successful free metered call fell in the week; volume = calls (reported, never paged); buckets are distinct ip buckets, not people",
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
    lines.append("Weekly ACTIVATIONS (buckets making their first successful free call) fell %d%%+ week over"
                 " week, beyond the pre-flip envelope, for %d %s:" % (int(GUARD_DROP * 100), len(breaches), noun))
    for j in breaches:
        lines.append("• client family %s: %d → %d activating buckets/week (−%s %%; its largest pre-flip weekly drop was %s %%)"
                     % (j["family"], j["prev_w"], j["cur_w"], j["drop_pct"], j["envelope_pct"]))
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


def run_probe(ref_iso=None, weeks=None) -> dict:
    env_args = []
    if ref_iso:
        env_args += ["-e", "STEPUP_REF_ISO=%s" % ref_iso]
    if weeks:
        env_args += ["-e", "STEPUP_WEEKS=%d" % int(weeks)]
    proc = subprocess.run(["docker", "exec"] + env_args + [APP_CONTAINER, "node", "-e", PROBE_JS],
                          capture_output=True, text=True, timeout=90)
    if proc.returncode != 0:
        raise RuntimeError("probe exit %d: %s" % (proc.returncode, (proc.stderr or "").strip()[:200]))
    probe = json.loads(proc.stdout)
    for key in ("mode", "n", "d0", "d1", "ref", "weeks", "sql"):
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
    volume = evaluate_volume(rows["act"])
    env_doc, env_reason = load_envelope()
    judged = evaluate_activation(weekly_by_family(rows["actw"], 2), env_doc["families"] if env_doc else None)
    metrics = build_metrics(probe, rows, judged, volume, env_doc, env_reason)
    for j in judged:
        log("ACTIVATION family=%s prev_w=%d cur_w=%d drop_pct=%s envelope_pct=%s state=%s"
            % (j["family"], j["prev_w"], j["cur_w"], j["drop_pct"], j["envelope_pct"], j["state"]))
    for v in volume:
        log("VOLUME family=%s prev7=%d cur7=%d drop_pct=%s (reported, never paged)"
            % (v["family"], v["prev7"], v["cur7"], v["drop_pct"]))
    log("POOLS %s" % json.dumps(metrics["free_metered_1d"], separators=(",", ":"))[:600])
    log("OAUTH_TRIGGER=%s anthropic_calls_30d=%d" % (metrics["oauth_trigger"], metrics["anthropic_calls_30d"]))
    log("ENVELOPE %s" % ("frozen, reference_day=%s" % env_doc.get("reference_day") if env_doc else env_reason))
    if should_page(probe["mode"]) and env_doc is None:
        log("INDETERMINATE: STEPUP_MODE=live but no frozen activation envelope (%s) — the guard cannot "
            "decide; run --freeze-envelope --flip-at <flip instant>" % env_reason)
        record("INDETERMINATE", 3, metrics)
        return finish("INDETERMINATE", 3)
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


def freeze_envelope(flip_at_iso: str, force: bool = False) -> int:
    """Compute the activation envelope from request_log for the 7 weeks before the flip's UTC day
    and freeze it at ENVELOPE_PATH. Refuses to overwrite a frozen envelope without --force: the
    envelope is the PRE-flip baseline, and recomputing it later would fold post-flip weeks in.
    Token: STEPUP_ENVELOPE_VERDICT=WRITTEN|EXISTS|INDETERMINATE (exit 0/0/3)."""
    if os.path.exists(ENVELOPE_PATH) and not force:
        log("ENVELOPE_EXISTS at %s — refusing to overwrite the frozen pre-flip baseline" % ENVELOPE_PATH)
        print("STEPUP_ENVELOPE_VERDICT=EXISTS", flush=True)
        return 0
    try:
        probe = run_probe(ref_iso=flip_at_iso, weeks=ENVELOPE_WEEKS + 1)
        rows = parse_rows(run_sql(probe["sql"]))
    except Exception as e:  # noqa: BLE001
        log("ENVELOPE_INDETERMINATE: %s" % str(e)[:240])
        print("STEPUP_ENVELOPE_VERDICT=INDETERMINATE", flush=True)
        return 3
    fams = compute_envelope(weekly_by_family(rows["actw"], ENVELOPE_WEEKS + 1))
    if not fams:
        log("ENVELOPE_INDETERMINATE: zero activating families before %s — nothing to freeze" % probe.get("ref"))
        print("STEPUP_ENVELOPE_VERDICT=INDETERMINATE", flush=True)
        return 3
    doc = {
        "flipped_at": flip_at_iso,
        "reference_day": probe["ref"],
        "weeks": ENVELOPE_WEEKS + 1,
        "mode_at_freeze": probe["mode"],
        "computed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rule": ("weekly activations = buckets whose first successful free metered call fell in each 7-day "
                 "window before reference_day (weekly[0] most recent); drops_pct[j] = week j against week j+1; "
                 "envelope_pct = the largest defined drop. A live drop pages only if prior >= %d, drop >= %d %% "
                 "and drop > envelope_pct." % (ACT_MIN_PRIOR_WEEK, int(GUARD_DROP * 100))),
        "families": fams,
    }
    tmp = ENVELOPE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, ENVELOPE_PATH)
    for fam, f in sorted(fams.items(), key=lambda kv: -sum(kv[1]["weekly"])):
        log("ENVELOPE family=%s weekly=%s envelope_pct=%s" % (fam, f["weekly"], f["envelope_pct"]))
    print("STEPUP_ENVELOPE_VERDICT=WRITTEN", flush=True)
    return 0


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
        "act|python-requests|900|1500|5",   # volume: −40 % — REPORTED, never paged
        "act|node|700|800|90",
        # activations: wk 0 = the last complete week, wk 1 = the one before
        "actw|node|0|4|", "actw|node|1|20|",                          # −80 %, envelope 57.1 → breach
        "actw|python-requests|0|3|", "actw|python-requests|1|6|",     # −50 %, envelope 75 → within_envelope
        "actw|claude|0|0|", "actw|claude|1|3|",                       # prior 3 < 5 → below_floor
        "actw|mcp-sdk|0|7|", "actw|mcp-sdk|1|10|",                    # −30 % exactly, envelope 25 → breach
        "actw|undici|0|1|", "actw|undici|1|9|",                       # −88.9 %, no envelope row → no_envelope
        "actw|growth|0|12|", "actw|growth|1|6|",                      # growth → ok
        "actw|node|9|99|",                                            # outside the 2-week window → ignored
        "garbage line",
        "unknown_label|1|2|3|4",
    ])
    rows = parse_rows(fixture)
    check("parse: every labelled row lands in its bucket",
          len(rows["calls_1d"]) == 3 and rows["anthropic_30d"] == {"calls": 64, "buckets": 1}
          and len(rows["stepup_1d"]) == 1 and len(rows["qhb_1d"]) == 1 and len(rows["act"]) == 2
          and len(rows["actw"]) == 13)
    weekly2 = weekly_by_family(rows["actw"], 2)
    check("activations: a window outside the requested weeks is ignored", weekly2["node"] == [4, 20])
    env_fams = compute_envelope({
        "node": [15, 35, 26, 10, 23, 33, 61],               # measured pre-flip shape, 2026-10-12
        "python-requests": [1, 2, 8, 4, 0, 0, 0],
        "mcp-sdk": [3, 4, 4, 4, 4, 4, 4],
        "claude": [0, 3, 3, 3, 3, 3, 3],
        "growth": [6, 6, 6, 6, 6, 6, 6],
        "silent": [0, 0, 0, 0, 0, 0, 0],
    })
    check("envelope: node's largest pre-flip weekly drop is 57.1 %", env_fams["node"]["envelope_pct"] == 57.1)
    check("envelope: weeks with no prior activations are UNDEFINED drops, never zeros",
          env_fams["python-requests"]["drops_pct"][3:] == [None, None, None]
          and env_fams["python-requests"]["envelope_pct"] == 75.0)
    check("envelope: a family that never activated has NO envelope (undefined, not 0 %)",
          env_fams["silent"]["envelope_pct"] is None)
    judged = evaluate_activation(weekly2, env_fams)
    state = {j["family"]: j["state"] for j in judged}
    check("guard: −80 % on 20, beyond node's 57.1 % envelope, is a breach", state["node"] == "breach")
    check("guard: −50 % inside python-requests' 75 % envelope is NOT a breach",
          state["python-requests"] == "within_envelope")
    check("guard: a prior week under 5 activating buckets is reported, never paged", state["claude"] == "below_floor")
    check("guard: the 30 % boundary is inclusive (and 30 > a 25 % envelope)", state["mcp-sdk"] == "breach")
    check("guard: a family with no envelope row is no_envelope — UNDEFINED, never a page", state["undici"] == "no_envelope")
    check("guard: growth is ok", state["growth"] == "ok")
    edge = {"x": {"envelope_pct": 50.0}}
    check("guard: prior exactly 5 is enough (5 → 1, −80 % > 50 %)",
          evaluate_activation({"x": [1, 5]}, edge)[0]["state"] == "breach")
    check("guard: prior 4 is not (4 → 0)", evaluate_activation({"x": [0, 4]}, edge)[0]["state"] == "below_floor")
    check("guard: a drop EQUAL to the envelope is within it — the ruling says LARGER",
          evaluate_activation({"x": [5, 10]}, edge)[0]["state"] == "within_envelope")
    check("guard: with no envelope at all, every would-be breach is no_envelope",
          all(j["state"] != "breach" for j in evaluate_activation(weekly2, None)))
    volume = evaluate_volume(rows["act"])
    check("volume: reported with its drop, and carries no paging state",
          [v["drop_pct"] for v in volume] == [40.0, 12.5] and all("state" not in v for v in volume))
    probe = {"mode": "shadow", "n": 20, "d0": "2026-10-12T00:00:00.000Z", "d1": "2026-10-13T00:00:00.000Z",
             "ref": "2026-10-13T00:00:00.000Z", "weeks": 2, "sql": ""}
    env_doc = {"reference_day": "2026-10-12T00:00:00.000Z", "computed_at": "2026-10-12T12:00:00Z", "families": env_fams}
    metrics = build_metrics(probe, rows, judged, volume, env_doc, None)
    check("metrics: pools aggregate calls and buckets", metrics["free_metered_1d"]["other"]["calls"] == 420
          and metrics["free_metered_1d"]["anthropic"]["buckets"] == 1)
    check("metrics: OAUTH_TRIGGER is NOT_MET below 1,000", metrics["oauth_trigger"] == "NOT_MET")
    rows_met = parse_rows("anthropic_30d|1000|3||")
    check("metrics: OAUTH_TRIGGER is MET at exactly 1,000",
          build_metrics(probe, rows_met, [])["oauth_trigger"] == "MET")
    check("metrics: activation breaches counted", metrics["activation_breaches"] == 2)
    check("metrics: the record says which envelope judged it, or why none did",
          metrics["envelope"]["reference_day"] == "2026-10-12T00:00:00.000Z"
          and build_metrics(probe, rows, judged, volume, None, "absent at /x")["envelope"] == {"state": "absent at /x"})
    check("metrics: volume rides along, reported", [v["family"] for v in metrics["volume"]] == ["python-requests", "node"])
    check("metrics: fits canary_result_log's 8 KiB line cap",
          len(json.dumps(metrics, separators=(",", ":"))) < 7000)
    big = parse_rows("\n".join(["calls_1d|other|fam%d|%d|1" % (i, i) for i in range(500)]
                               + ["actw|fam%d|%d|%d|" % (i, i % 2, i) for i in range(500)]))
    big_j = evaluate_activation(weekly_by_family(big["actw"], 2), None)
    check("metrics: 500 families still fit (top-N bound)",
          len(json.dumps(build_metrics(probe, big, big_j), separators=(",", ":"))) < 7000)
    body = build_body(judged)
    check("body: names the alert id and the entity noun", ALERT_ID in body and "client family node" in body)
    check("body: renders the activation numbers and the envelope",
          "20 → 4 activating buckets/week" in body and "57.1 %" in body)
    check("body: a below-floor / within-envelope / no-envelope family is not paged",
          "client family claude" not in body and "client family python-requests" not in body
          and "client family undici" not in body)
    check("body: carries a templated Action line, never a literal wave number", "OPS-STEPUP-ACTIVATION-W{NEXT}" in body)
    # The bypassed artifacts: the probe and the psql invocation are the only code no scenario runs,
    # so their SHAPE is asserted here (a hermetic self-test is blind to exactly what its seam replaces).
    check("probe: derives set A with the app's own hashIp", "require('/app/dist/lib/analytics.js')" in PROBE_JS and "hashIp('160.79.' + i + '.0')" in PROBE_JS)
    check("probe: the metered predicate is the app's billablePredicate()", "billablePredicate()" in PROBE_JS)
    check("probe: mode and N come from the deployed plans module", "plans.resolveStepupMode(process.env)" in PROBE_JS and "FREE_KEYLESS_MONTHLY_CALLS_RULED" in PROBE_JS)
    check("probe: covers addresses .104 through .111 (the /21)", "i <= 111" in PROBE_JS and "i = 104" in PROBE_JS)
    check("probe: activations are each v2 bucket's FIRST call (DISTINCT ON, earliest first)",
          "DISTINCT ON (ip_hash)" in PROBE_JS and "ORDER BY ip_hash, \"timestamp\")" in PROBE_JS
          and "ip_hash LIKE 'v2:%'" in PROBE_JS)
    check("probe: the activation windows end at REF (today, or the flip's UTC day via STEPUP_REF_ISO)",
          "process.env.STEPUP_REF_ISO" in PROBE_JS and "604800" in PROBE_JS and "ref: RISO" in PROBE_JS)
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
    import shutil
    import tempfile
    g = globals()
    real_probe, real_sql, real_env_path = g["run_probe"], g["run_sql"], g["ENVELOPE_PATH"]
    tmpd = tempfile.mkdtemp(prefix="stepup-env-")
    try:
        # The ENVELOPE: frozen once from request_log at the flip, refused on overwrite.
        g["ENVELOPE_PATH"] = os.path.join(tmpd, "envelope.json")
        check("envelope file: absent → (None, reason)", load_envelope()[0] is None and "absent" in load_envelope()[1])
        Path(g["ENVELOPE_PATH"]).write_text("{not json", encoding="utf-8")
        check("envelope file: unreadable → (None, reason), never a crash", load_envelope()[0] is None)
        os.remove(g["ENVELOPE_PATH"])
        seen = {}
        env_fixture = "\n".join("actw|node|%d|%d|" % (wk, n) for wk, n in enumerate([15, 35, 26, 10, 23, 33, 61]))

        def fake_probe(ref_iso=None, weeks=None, **_):
            seen["ref"], seen["weeks"] = ref_iso, weeks
            return {"mode": "shadow", "n": 20, "d0": "x", "d1": "y", "ref": "2026-10-12T00:00:00.000Z",
                    "weeks": weeks or 2, "sql": "-"}
        g["run_probe"] = fake_probe
        g["run_sql"] = lambda _sql: env_fixture
        rc_f = freeze_envelope("2026-10-12T13:00:00Z")
        doc, why = load_envelope()
        check("freeze: asks the probe for 7 weeks before the FLIP instant",
              seen.get("ref") == "2026-10-12T13:00:00Z" and seen.get("weeks") == 7)
        check("freeze: writes a readable envelope with node at 57.1 %",
              rc_f == 0 and doc is not None and doc["families"]["node"]["envelope_pct"] == 57.1)
        check("freeze: a second freeze REFUSES to overwrite the pre-flip baseline",
              freeze_envelope("2026-10-20T00:00:00Z") == 0 and load_envelope()[0]["flipped_at"] == "2026-10-12T13:00:00Z")
        check("freeze: --force overwrites", freeze_envelope("2026-10-20T00:00:00Z", force=True) == 0
              and load_envelope()[0]["flipped_at"] == "2026-10-20T00:00:00Z")
        g["run_sql"] = lambda _sql: ""
        os.remove(g["ENVELOPE_PATH"])
        check("freeze: zero activating families is INDETERMINATE (exit 3), never an empty envelope",
              freeze_envelope("2026-10-12T13:00:00Z") == 3 and not os.path.exists(g["ENVELOPE_PATH"]))
        # main(), end to end, with the two effects that reach production replaced by fixtures.
        Path(g["ENVELOPE_PATH"]).write_text(json.dumps(env_doc), encoding="utf-8")
        g["run_sql"] = lambda _sql: fixture
        for mode, want in (("shadow", "PASS"), ("off", "PASS"), ("live", "FAIL")):
            LAST_FIRE.clear(); LAST_RECORD.clear()
            g["run_probe"] = lambda m=mode, **_: {"mode": m, "n": 20, "d0": "2026-10-12T00:00:00.000Z",
                                                  "d1": "2026-10-13T00:00:00.000Z", "ref": "2026-10-13T00:00:00.000Z",
                                                  "weeks": 2, "sql": "-"}
            main()
            check("main(): an activation breach in %s → %s%s" % (mode, want, " (paged)" if want == "FAIL" else " (reported, not paged)"),
                  LAST_RECORD[:1] == [want] and (ALERT_ID in LAST_FIRE) == (want == "FAIL"))
        os.remove(g["ENVELOPE_PATH"])
        LAST_FIRE.clear(); LAST_RECORD.clear()
        rc_live_noenv = main()
        check("main(): live with NO frozen envelope is INDETERMINATE, exit 3, and pages nothing",
              rc_live_noenv == 3 and LAST_RECORD[:1] == ["INDETERMINATE"] and not LAST_FIRE)
        LAST_FIRE.clear(); LAST_RECORD.clear()
        g["run_probe"] = lambda **_: (_ for _ in ()).throw(RuntimeError("docker exec failed"))
        rc = main()
        check("main(): an unreadable probe is INDETERMINATE, exit 3, and pages nothing",
              rc == 3 and LAST_RECORD[:1] == ["INDETERMINATE"] and not LAST_FIRE)
    finally:
        g["run_probe"], g["run_sql"], g["ENVELOPE_PATH"] = real_probe, real_sql, real_env_path
        shutil.rmtree(tmpd, ignore_errors=True)
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
    if len(sys.argv) > 1 and sys.argv[1] == "--freeze-envelope":
        flip_at = sys.argv[sys.argv.index("--flip-at") + 1] if "--flip-at" in sys.argv else \
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        sys.exit(freeze_envelope(flip_at, force="--force" in sys.argv))
    sys.exit(main())

#!/usr/bin/env python3
"""postgres-cpu-autopilot.py — OPS-POSTGRES-CPU-AUTOPILOT-W1

Detect → Classify → Recover → Verify → Escalate state machine.
Invoked by postgres-cpu-snapshot.sh when a drift trigger fires (persistent: the FULL 28-sample
window averages > BASELINE_PCT 10%; trajectory: the last 3 samples are all > 50%).
Reads pg_stat_statements via psql shell-out as algovault_autopilot (role).
Classifies dominant query against registry; if known fix-shape, executes
idempotent recovery; verifies CPU drops < BASELINE_RECOVERED_PCT (15%);
else escalates via wrapper.

Exit codes:
  0 = SILENT recovery succeeded (snapshot.sh skips wrapper)
  1 = ESCALATE (autopilot emits body to stdout)
  2 = CRITICAL_BYPASS (avg > 50% OR peak > 90%)
  3 = FRAMEWORK_ERROR (DB unreachable, registry malformed, bad argv, etc.)

Constants (architect-ratified, no env overrides):
  CEILING_RECOVERIES_PER_24H = 5
  CEILING_CONSECUTIVE = 3
  CEILING_RECOVERY_DURATION_S = 60
  CEILING_COOLDOWN_S = 3600
  CRITICAL_BYPASS_AVG_PCT = 50
  CRITICAL_BYPASS_PEAK_PCT = 90

Environment:
  DRY_RUN_AUTOPILOT=1 — classify+log but don't execute recovery action (Q-E)
  CLASS_OVERRIDE=<class> — for synthetic ceiling/test smokes
  PG_CPU_WINDOW_N / PG_CPU_WINDOW_SPAN — set by postgres-cpu-snapshot.sh; rendered in the body

── ALERT-BODY HONESTY (OPS-POSTGRES-CPU-WINDOW-INTEGRITY-W1, 2026-09-29) ─────────────────────────
The 2026-09-28T18:48Z page was false in five fields, each fixed at the line that wrote it:
  * "recovery_failed action=escalate" — `escalate` is a class's DECLARED diagnose-only action, not a
    recovery that failed. It renders `diagnose_only` now, and it no longer writes the recovery
    ceilings' state (that run had recorded 4 non-recoveries against CEILING_RECOVERIES_PER_24H=5).
  * "Classified class: runaway-cron" — the class line carries what the classifier MEASURED
    (e.g. `process_count=15 > max_concurrent=6`), so a saturated classifier announces itself.
  * the Action line was hardcoded here while every registry row's `recommended_wave_template` went
    unread; it is read from the classified row now (single derivation).
  * the Audit line cited a doc that exists in neither the repo nor the vault.
  * "Rolling avg" carried no window — the one fact that would have shown n=8 where 28 was meant —
    and the pg_stat_statements "top-1" carried none either (it was a 116-day cumulative rank).
Plus a latent one: an argparse error exited 2, which snapshot.sh routes as CRITICAL_BYPASS with the
usage text as the page. Bad argv is FRAMEWORK_ERROR (3).

── WINDOW ATTRIBUTION (OPS-ALARM-OWNER-DERIVATION-W1 CH3, 2026-10-11) ───────────────────────────
pg_stat_statements ranks CUMULATIVELY since stats_reset (2026-06-05), so classify() used to be fed
whatever had dominated since June — not what was burning CPU in the window that fired. Now every
snapshot run records one pg_stat_statements set into a wall-time window store (--record-pgss), and
classify() is fed the statement with the largest Σ Δtotal_exec_time over the SAME window the firing
leg used (persistent: the trailing 7 days; trajectory: the last 3 point samples). A per-queryid delta
whose `calls` fell (evicted / reset) is dropped; a stats_reset change inside the window drops the
window — attribution INDETERMINATE, class UNKNOWN, and the body says why. The cumulative top-1 stays,
labelled. The body renders both CPU instruments the snapshot reports (PG_CPU_FACTS): the 7-day
integral that decides persistence and the point 28-instant mean that no longer decides anything.

  postgres-cpu-autopilot.py --self-test    # hermetic: no DB, no host path, no yaml needed
  postgres-cpu-autopilot.py --record-pgss  # one pg_stat_statements snapshot into PG_CPU_PGSS_DIR
"""
from __future__ import annotations

import argparse, calendar, contextlib, io, json, logging, os, re, shutil, subprocess, sys, tempfile, time, types
from pathlib import Path

try:
    import yaml
except ImportError:  # --self-test needs no yaml; main() refuses without it (FRAMEWORK_ERROR)
    yaml = None

# Constants (architect-ratified — no env overrides)
CEILING_RECOVERIES_PER_24H = 5
CEILING_CONSECUTIVE = 3
CEILING_RECOVERY_DURATION_S = 60
CEILING_COOLDOWN_S = 3600
CRITICAL_BYPASS_AVG_PCT = 50.0
CRITICAL_BYPASS_PEAK_PCT = 90.0
BASELINE_RECOVERED_PCT = 15.0

# Paths
AUTOPILOT_PATH = "/opt/algovault-monitoring/postgres-cpu-autopilot.py"
REGISTRY_PATH = "/opt/algovault-monitoring/postgres-cpu-autopilot-registry.yaml"
STATE_DIR = Path("/opt/algovault-monitoring/.autopilot-state")
LOG_PATH = "/var/log/postgres-cpu-autopilot.log"
CREDS_PATH = "/opt/algovault-monitoring/autopilot-pg-creds"
POSTGRES_CONTAINER = "crypto-quant-signal-mcp-postgres-1"
DB_NAME = "signal_performance"
PG_USER = "algovault_autopilot"

# Body
DEFAULT_RECOMMENDED_WAVE = "OPS-POSTGRES-AUTOPILOT-MANIFEST-EXPAND-W{NEXT}"  # fallback only: no registry loaded
AUDIT_DOC = "audits/POSTGRES_CPU_DRIFT_UNIFIED-2026-09-29.md"
DIAGNOSE_ONLY = "escalate"  # a class whose recovery_action is this is diagnose-only BY DECLARATION

# Window attribution store (CH3 Req 4). One file per snapshot run, named by its UTC instant.
PGSS_DIR_DEFAULT = "/var/lib/algovault-monitoring/pgss-window"
PGSS_KEEP_S = 8 * 86400          # the same 8 days as the integral record, trimmed by WALL time
PGSS_TEXT_TOP_N = 50             # texts kept per snapshot: the top-N cumulative ∪ the top-N by delta
PGSS_TEXT_MAX = 400
PGSS_ACTIVE_MAX = 20
PGSS_NAME_RE = re.compile(r"^(\d{8}T\d{6}Z)\.tsv$")

# Exit codes
EXIT_SILENT = 0
EXIT_ESCALATE = 1
EXIT_CRITICAL_BYPASS = 2
EXIT_FRAMEWORK_ERROR = 3


class ArgParser(argparse.ArgumentParser):
    """argparse exits 2 on bad argv, and snapshot.sh routes 2 as CRITICAL_BYPASS."""

    def error(self, message):
        self.print_usage(sys.stderr)
        print(f"{self.prog}: error: {message}", file=sys.stderr)
        sys.exit(EXIT_FRAMEWORK_ERROR)


def setup_logging():
    Path(LOG_PATH).parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=LOG_PATH, level=logging.INFO,
                        format="%(asctime)sZ %(message)s", datefmt="%Y-%m-%dT%H:%M:%S")


def log_event(**fields):
    parts = []
    for k, v in fields.items():
        if isinstance(v, str) and (" " in v or "=" in v):
            parts.append(f'{k}={json.dumps(v)}')
        else:
            parts.append(f'{k}={v}')
    logging.info(" ".join(parts))


def load_registry():
    if yaml is None:
        return None
    try:
        with open(REGISTRY_PATH) as f:
            return yaml.safe_load(f)
    except (OSError, yaml.YAMLError):
        return None


def read_creds():
    try:
        with open(CREDS_PATH) as f:
            for line in f:
                if line.startswith("PGPASSWORD="):
                    return line.strip().split("=", 1)[1]
    except OSError:
        pass
    return None


def psql_run(sql, timeout=10, user=PG_USER):
    pgpw = read_creds() if user == PG_USER else os.environ.get("PGPASSWORD", "")
    try:
        result = subprocess.run(
            ["docker", "exec", "-e", f"PGPASSWORD={pgpw or ''}", POSTGRES_CONTAINER,
             "psql", "-U", user, "-d", DB_NAME, "-tAc", sql],
            capture_output=True, text=True, timeout=timeout)
        return result.stdout.strip(), result.returncode
    except (subprocess.TimeoutExpired, OSError):
        return None, -1


def probe_pg_stat_statements(top_n=3):
    sql = ("SELECT query, round(total_exec_time::numeric, 0), calls, "
           "round(mean_exec_time::numeric, 2) FROM pg_stat_statements "
           f"ORDER BY total_exec_time DESC LIMIT {top_n};")
    out, rc = psql_run(sql, timeout=10)
    if rc != 0 or out is None:
        return None
    rows = []
    for line in out.split("\n"):
        if not line.strip():
            continue
        parts = line.split("|")
        if len(parts) >= 4:
            try:
                rows.append((parts[0].strip(), int(parts[1]), int(parts[2]), float(parts[3])))
            except (ValueError, IndexError):
                continue
    return rows


def probe_stats_window():
    """pg_stat_statements ranks CUMULATIVELY since stats_reset — say how long that is."""
    out, rc = psql_run("SELECT to_char(stats_reset AT TIME ZONE 'UTC', 'YYYY-MM-DD'), "
                       "floor(extract(epoch FROM now() - stats_reset) / 86400)::int "
                       "FROM pg_stat_statements_info;", timeout=10)
    if rc != 0 or not out or "|" not in out:
        return None
    day, age = out.split("|", 1)
    return f"since {day.strip()}, {age.strip()}d"


def _process_count(pattern):
    try:
        r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True, timeout=3)
        return len([l for l in r.stdout.split("\n") if l.strip()])
    except (subprocess.TimeoutExpired, OSError, FileNotFoundError):
        return None


def _unit_state(unit):
    try:
        r = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True, timeout=3)
        return r.stdout.strip() or "unknown"
    except (subprocess.TimeoutExpired, OSError, FileNotFoundError):
        return None


def _disk_pct(path):
    try:
        r = subprocess.run(["df", "--output=pcent", path], capture_output=True, text=True, timeout=3)
        for line in r.stdout.split("\n"):
            line = line.strip().rstrip("%")
            if line.isdigit():
                return int(line)
    except (subprocess.TimeoutExpired, OSError, FileNotFoundError):
        pass
    return None


def classify(dominant_query, registry):
    """First match wins, in registry order. Returns (class_name, evidence): the evidence is what the
    classifier MEASURED, rendered into the body so a saturated classifier announces itself."""
    if not registry or not registry.get("classes"):
        return "UNKNOWN", "no registry classes loaded"
    for cls in registry["classes"]:
        name = cls.get("name")
        if name == "UNKNOWN":
            continue
        ctype = cls.get("classifier_type", "pg_query_regex")
        a = cls.get("classifier_args") or {}
        if ctype == "pg_query_regex":
            regex = cls.get("classifier_regex", "")
            if regex and re.search(regex, dominant_query, re.IGNORECASE):
                return name, "pg_query_regex matched the window top-1 statement"
        elif ctype == "process_count":
            n, cap = _process_count(a.get("pattern", "")), a.get("max_concurrent", 1)
            if n is not None and n > cap:
                return name, f"process_count={n} > max_concurrent={cap}"
        elif ctype == "systemctl_status":
            unit = a.get("unit", "cron.service")
            state = _unit_state(unit)
            if state is not None and state != "active":
                return name, f"{unit} is-active={state}"
        elif ctype == "disk_usage":
            path, cap = a.get("path", "/"), a.get("threshold_pct", 90)
            pct = _disk_pct(path)
            if pct is not None and pct > cap:
                return name, f"{path} at {pct}% > {cap}%"
    return "UNKNOWN", "no registry class matched"


def find_class(registry, name):
    return next((c for c in (registry or {}).get("classes", []) if c.get("name") == name), None)


def recommended_wave(registry, name):
    """The classified row's `recommended_wave_template` is the SoT; the constant only covers a
    registry that could not be loaded at all."""
    return (find_class(registry, name) or {}).get("recommended_wave_template") or DEFAULT_RECOMMENDED_WAVE


def window_text(env=None):
    env = os.environ if env is None else env
    n, span = env.get("PG_CPU_WINDOW_N", ""), env.get("PG_CPU_WINDOW_SPAN", "")
    if not n:
        return "an unreported window (snapshot predates window reporting)"
    return f"{n} samples ({span})" if span else f"{n} samples"


# ── WINDOW ATTRIBUTION (CH3 Req 4–6) ─────────────────────────────────────────────────────────────

def pgss_dir(env=None):
    env = os.environ if env is None else env
    return Path(env.get("PG_CPU_PGSS_DIR") or PGSS_DIR_DEFAULT)


def _stamp(epoch):
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(epoch))


def _from_stamp(stamp):
    return calendar.timegm(time.strptime(stamp, "%Y%m%dT%H%M%SZ"))


def _clean(value, limit):
    """One store field: no tab, newline or pipe can survive into it, and it is bounded."""
    return re.sub(r"[\t\r\n|]+", " ", str(value)).strip()[:limit]


_LITERAL_RE = re.compile(r"'(?:[^']|'')*'")
_NUMBER_RE = re.compile(r"\b\d+(?:\.\d+)?\b")


def strip_literals(query):
    """pg_stat_activity carries the RAW statement; no literal may reach the store or a page."""
    return _NUMBER_RE.sub("?", _LITERAL_RE.sub("'?'", query))


def serialize_pgss(snap):
    """PURE. One snapshot → the store's TSV text."""
    lines = [f"meta\tts\t{snap['ts']}", f"meta\tstats_reset\t{snap['stats_reset']}"]
    lines += [f"q\t{qid}\t{calls}\t{total}" for qid, (calls, total) in sorted(snap["q"].items())]
    lines += [f"t\t{qid}\t{_clean(text, PGSS_TEXT_MAX)}" for qid, text in sorted(snap["texts"].items())]
    lines += ["a\t" + "\t".join(_clean(a[k], PGSS_TEXT_MAX) for k in ("pid", "state", "wait", "dur_s", "query_id", "text"))
              for a in snap["active"]]
    return "\n".join(lines) + "\n"


def parse_pgss(text):
    """PURE. The store's TSV text → a snapshot. ValueError on a file with no ts or no stats_reset."""
    snap = {"ts": None, "stats_reset": None, "q": {}, "texts": {}, "active": []}
    for line in text.splitlines():
        f = line.split("\t")
        if f[0] == "meta" and len(f) == 3:
            if f[1] == "ts":
                snap["ts"] = int(f[2])
            elif f[1] == "stats_reset":
                snap["stats_reset"] = f[2]
        elif f[0] == "q" and len(f) == 4:
            snap["q"][f[1]] = (int(f[2]), float(f[3]))
        elif f[0] == "t" and len(f) == 3:
            snap["texts"][f[1]] = f[2]
        elif f[0] == "a" and len(f) == 7:
            snap["active"].append(dict(zip(("pid", "state", "wait", "dur_s", "query_id", "text"), f[1:])))
    if snap["ts"] is None or not snap["stats_reset"]:
        raise ValueError("snapshot without ts or stats_reset")
    return snap


def pair_deltas(prev, cur):
    """PURE. Per-queryid Δtotal_exec_time across one consecutive pair. A statement absent from `prev`
    entered inside the interval (its whole total is the delta); a statement whose `calls` FELL was
    evicted and re-entered, or reset — its delta is dropped, never invented."""
    out = {}
    for qid, (calls, total) in cur["q"].items():
        p = prev["q"].get(qid)
        if p is None:
            out[qid] = total
        elif calls >= p[0]:
            out[qid] = max(total - p[1], 0.0)
    return out


def attribute(snaps):
    """PURE. Σ Δtotal_exec_time over the consecutive pairs of `snaps` (oldest first), CH3 Req 5."""
    if len(snaps) < 2:
        return {"status": "indeterminate",
                "reason": f"{len(snaps)} pg_stat_statements snapshot(s) in the window, a delta needs 2"}
    resets = sorted({s["stats_reset"] for s in snaps})
    if len(resets) > 1:
        return {"status": "indeterminate",
                "reason": f"stats_reset changed inside the window ({' -> '.join(resets)}), so the window is dropped"}
    window = {}
    for prev, cur in zip(snaps, snaps[1:]):
        for qid, ms in pair_deltas(prev, cur).items():
            window[qid] = window.get(qid, 0.0) + ms
    texts = {}
    for s in snaps:
        texts.update(s["texts"])

    def top(deltas, n=3):
        total = sum(deltas.values())
        ranked = [k for k in sorted(deltas, key=deltas.get, reverse=True) if deltas[k] > 0][:n]
        return [{"qid": k, "ms": deltas[k], "share": 100.0 * deltas[k] / total, "text": texts.get(k)} for k in ranked]

    ranked = top(window)
    if not ranked:
        return {"status": "indeterminate", "reason": "no statement executed inside the window"}
    return {"status": "ok", "top": ranked, "last": top(pair_deltas(snaps[-2], snaps[-1])),
            "from_ts": snaps[0]["ts"], "to_ts": snaps[-1]["ts"], "last_from_ts": snaps[-2]["ts"],
            "n": len(snaps), "stats_reset": resets[0], "total_ms": sum(window.values())}


def window_class(att, registry, label):
    """(dominant_statement, class, evidence) — classify() is fed the WINDOW top-1, never a guess."""
    if att["status"] != "ok":
        return "", "UNKNOWN", f"window attribution INDETERMINATE: {att['reason']}"
    statement = att["top"][0]["text"] or ""
    name, evidence = classify(statement, registry)
    return statement, name, f"{evidence}; window: {label}"


def statement_share_line(att, label, cpu_pct):
    """PURE. CH3 post-GREEN ruling Q7: what share of the window's CONTAINER CPU the ranked statement time
    is. pg_stat_statements counts statement wall time only — no parallel-worker CPU (pgss_enabled()
    requires !IsParallelWorker()) and no planning (track_planning off) — so the class below names the
    top STATEMENT-time consumer. `cpu_pct` is the integral over the same window; None renders n/a."""
    span = att["to_ts"] - att["from_ts"]
    stmt = (att["total_ms"] / 1000.0) / span * 100.0 if span > 0 else 0.0
    if isinstance(cpu_pct, (int, float)) and not isinstance(cpu_pct, bool) and cpu_pct > 0:
        cpu, ratio = f"{cpu_pct:.1f} % of one core", f"{100.0 * stmt / cpu_pct:.1f} %"
    else:
        cpu, ratio = "n/a (no covered integral segment)", "n/a"
    return (f"Statement time vs CPU ({label}): Σ Δexec = {stmt:.1f} % of one core vs container CPU {cpu} "
            f"(integral, same window) → {ratio} of it; the class names the top STATEMENT-time consumer, "
            f"not the top CPU consumer")


def attribution_lines(att, latest, label, cpu_pct=None):
    """PURE. CH3 Req 6's attribution lines (the cumulative top-1 is rendered by the body, labelled)."""
    hm = lambda t: time.strftime("%Y-%m-%dT%H:%MZ", time.gmtime(t))

    def items(rows):
        if not rows:
            return "none"
        return " · ".join(f"{i}) {r['ms']:,.0f} ms ({r['share']:.1f}%) "
                          f"{(r['text'] or '<text not recorded> queryid=' + r['qid'])[:100]}"
                          for i, r in enumerate(rows, 1))

    if att["status"] == "ok":
        lines = [f"Window top-3 by Δexec ({label}, {hm(att['from_ts'])}..{hm(att['to_ts'])}, {att['n']} snapshots): "
                 f"{items(att['top'])}",
                 statement_share_line(att, label, cpu_pct),
                 f"Last-interval top-3 by Δexec ({hm(att['last_from_ts'])}..{hm(att['to_ts'])}): {items(att['last'])}"]
    else:
        lines = [f"Window attribution ({label}): INDETERMINATE, {att['reason']}; class UNKNOWN, never invented"]
    if latest is None:
        lines.append("Active at the sample instant: no pg_stat_statements snapshot recorded")
    else:
        acts = latest["active"]
        shown = " · ".join(f"{a['state']} {a['dur_s']}s {(latest['texts'].get(a['query_id']) or a['text'])[:80]}"
                           for a in acts[:3])
        lines.append(f"Active at the sample instant ({hm(latest['ts'])}): "
                     + (f"{len(acts)} non-idle backend(s): {shown}" if acts else "no non-idle backend"))
    return lines


def load_pgss_window(d, from_s, to_s):
    """(snapshots inside [from_s, to_s] oldest first, count of unparseable files skipped)."""
    snaps, bad = [], 0
    if not d.is_dir():
        return snaps, bad
    for p in sorted(d.iterdir()):
        m = PGSS_NAME_RE.match(p.name)
        if not m or not (from_s <= _from_stamp(m.group(1)) <= to_s):
            continue
        try:
            snaps.append(parse_pgss(p.read_text()))
        except (OSError, ValueError):
            bad += 1
    snaps.sort(key=lambda s: s["ts"])
    return snaps, bad


def latest_pgss(d):
    """The newest parseable snapshot in the store, or None."""
    if not d.is_dir():
        return None
    for p in sorted((q for q in d.iterdir() if PGSS_NAME_RE.match(q.name)), reverse=True):
        try:
            return parse_pgss(p.read_text())
        except (OSError, ValueError):
            continue
    return None


def fetch_pgss(run, prev, now):
    """The live read for one snapshot, as algovault_autopilot (pg_read_all_stats). RuntimeError on any
    unreadable part a snapshot cannot do without."""
    out, rc = run("SELECT to_char(stats_reset AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') "
                  "FROM pg_stat_statements_info;")
    if rc != 0 or not out:
        raise RuntimeError("pg_stat_statements_info unreadable")
    stats_reset = out.strip()
    out, rc = run("SELECT queryid, calls, total_exec_time FROM pg_stat_statements WHERE queryid IS NOT NULL;", timeout=30)
    if rc != 0 or out is None:
        raise RuntimeError("pg_stat_statements unreadable")
    q = {}
    for line in out.splitlines():
        f = line.split("|")
        if len(f) == 3 and re.fullmatch(r"-?\d+", f[0].strip()):
            q[f[0].strip()] = (int(f[1]), float(f[2]))
    if not q:
        raise RuntimeError("pg_stat_statements returned no statements")
    want = set(sorted(q, key=lambda k: q[k][1], reverse=True)[:PGSS_TEXT_TOP_N])
    if prev is not None and prev["stats_reset"] == stats_reset:
        d = pair_deltas(prev, {"q": q})
        want |= set(sorted(d, key=d.get, reverse=True)[:PGSS_TEXT_TOP_N])
    texts = {}
    out, rc = run(f"SELECT queryid, regexp_replace(left(query, {PGSS_TEXT_MAX}), '[[:space:]|]+', ' ', 'g') "
                  f"FROM pg_stat_statements WHERE queryid IN ({','.join(sorted(want))});", timeout=30)
    if rc == 0 and out:
        for line in out.splitlines():
            k, _, v = line.partition("|")
            if k.strip():
                texts[k.strip()] = v.strip()
    active = []
    out, rc = run("SELECT pid, state, coalesce(wait_event_type, ''), "
                  "coalesce(round(extract(epoch FROM now() - query_start))::int, 0), coalesce(query_id::text, ''), "
                  "regexp_replace(left(query, 300), '[[:space:]|]+', ' ', 'g') FROM pg_stat_activity "
                  "WHERE backend_type = 'client backend' AND state IS NOT NULL AND state <> 'idle' "
                  "AND pid <> pg_backend_pid();")
    if rc == 0 and out:
        for line in out.splitlines()[:PGSS_ACTIVE_MAX]:
            f = line.split("|", 5)
            if len(f) == 6:
                active.append(dict(pid=f[0], state=f[1], wait=f[2], dur_s=f[3], query_id=f[4],
                                   text=strip_literals(f[5])))
    return {"ts": now, "stats_reset": stats_reset, "q": q, "texts": texts, "active": active}


def record_pgss(env=None, now=None, run=None):
    """--record-pgss: one snapshot into the window store, atomically; the store trimmed by WALL time.
    Prints exactly one PGSS_RECORD=ok|failed line. Returns 0 (ok) or 3 (failed) — the snapshot calls it
    fail-open, so a failure is logged there and never changes a verdict."""
    d = pgss_dir(env)
    now = int(time.time()) if now is None else now
    try:
        snap = fetch_pgss(run or psql_run, latest_pgss(d), now)
        d.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(d), prefix=".pgss.", suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            f.write(serialize_pgss(snap))
        path = d / (_stamp(now) + ".tsv")
        os.replace(tmp, path)
        trimmed = 0
        for p in d.iterdir():
            m = PGSS_NAME_RE.match(p.name)
            if m and _from_stamp(m.group(1)) < now - PGSS_KEEP_S:
                p.unlink()
                trimmed += 1
    except Exception as e:  # noqa: BLE001 — a recorder failure is a token, never a crash
        print(f"PGSS_RECORD=failed reason={type(e).__name__}: {str(e)[:200]}")
        return EXIT_FRAMEWORK_ERROR
    print(f"PGSS_RECORD=ok file={path} statements={len(snap['q'])} texts={len(snap['texts'])} "
          f"active={len(snap['active'])} stats_reset={snap['stats_reset']} trimmed={trimmed}")
    return EXIT_SILENT


def parse_facts(raw):
    """The snapshot's instrument facts (PG_CPU_FACTS, JSON). Anything unreadable is {} — said, not guessed."""
    try:
        f = json.loads(raw or "")
    except ValueError:
        return {}
    return f if isinstance(f, dict) else {}


def instruments_line(facts, point_avg):
    """PURE. Both CPU instruments side by side, so a collision between them announces itself."""
    base = facts.get("point_baseline_pct")
    point = (f"28-instant mean (point, docker stats median-of-30 @ :47): {facts.get('point_mean', point_avg)}%"
             + (f" vs {base}% (reported, decides nothing)" if base is not None else " (reported)"))
    if facts.get("persistent_instrument") != "integral":
        return f"7-day mean (integral): not reported by the caller · {point}"
    mean = facts.get("integral_mean")
    return (f"7-day mean (integral, cgroup usage_usec, coverage {facts.get('integral_coverage_pct', 'n/a')}%): "
            f"{'n/a' if mean is None else str(mean) + '%'} vs {facts.get('integral_persistent_pct', 'n/a')}% "
            f"(provisional until {facts.get('provisional_until', 'n/a')}) · {point}")


def get_class_state(class_name):
    cd = STATE_DIR / class_name
    cd.mkdir(parents=True, exist_ok=True)
    now = int(time.time())
    cutoff = now - 86400
    epochs = []
    ep_path = cd / "recoveries-24h.epochlist"
    if ep_path.exists():
        try:
            for line in ep_path.read_text().split("\n"):
                line = line.strip()
                if line.isdigit() and int(line) >= cutoff:
                    epochs.append(int(line))
        except OSError:
            pass
    consec = 0
    c_path = cd / "consecutive-count"
    if c_path.exists():
        try:
            consec = int(c_path.read_text().strip() or "0")
        except (ValueError, OSError):
            pass
    last = 0
    l_path = cd / "last-recovery-epoch"
    if l_path.exists():
        try:
            last = int(l_path.read_text().strip() or "0")
        except (ValueError, OSError):
            pass
    return {"recoveries_24h": len(epochs), "epochs": epochs,
            "consecutive": consec, "last_epoch": last}


def update_class_state(class_name, success=True):
    cd = STATE_DIR / class_name
    cd.mkdir(parents=True, exist_ok=True)
    now = int(time.time())
    state = get_class_state(class_name)
    epochs = list(state["epochs"]) + [now]
    (cd / "recoveries-24h.epochlist").write_text("\n".join(str(e) for e in epochs) + "\n")
    new_consec = (state["consecutive"] + 1) if (now - state["last_epoch"] < CEILING_COOLDOWN_S) else 1
    (cd / "consecutive-count").write_text(str(new_consec))
    (cd / "last-recovery-epoch").write_text(str(now))


def check_ceilings(class_name):
    s = get_class_state(class_name)
    if s["recoveries_24h"] >= CEILING_RECOVERIES_PER_24H:
        return True, f"CEILING_TRIPPED: recoveries_24h={s['recoveries_24h']} >= {CEILING_RECOVERIES_PER_24H}"
    if s["consecutive"] >= CEILING_CONSECUTIVE:
        return True, f"CEILING_TRIPPED: consecutive={s['consecutive']} >= {CEILING_CONSECUTIVE}"
    return False, ""


def execute_recovery(class_name, registry):
    cls = find_class(registry, class_name)
    if not cls:
        return False, "unknown_class", 0.0
    action = cls.get("recovery_action", "")
    args = cls.get("recovery_action_args", {})
    timeout = min(cls.get("expected_max_duration_s", 30), CEILING_RECOVERY_DURATION_S)
    start = time.time()
    success = False
    try:
        if action == "psql_refresh_matview":
            mv = args.get("matview_name", "")
            conc = "CONCURRENTLY" if args.get("concurrently", True) else ""
            out, rc = psql_run(f"REFRESH MATERIALIZED VIEW {conc} {mv}", timeout=timeout)
            success = (rc == 0)
        elif action == "kill_term_excess_pids":
            pattern = args.get("pattern", "")
            max_c = args.get("max_concurrent", 1)
            r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True, timeout=3)
            pids = sorted([int(p) for p in r.stdout.split("\n") if p.strip().isdigit()])
            if len(pids) > max_c:
                for pid in pids[:-max_c]:
                    try:
                        os.kill(pid, 15)
                    except (ProcessLookupError, PermissionError):
                        pass
                success = True
        elif action == "systemctl_restart_cron":
            r = subprocess.run(["systemctl", "restart", args.get("unit", "cron.service")],
                               capture_output=True, text=True, timeout=timeout)
            success = (r.returncode == 0)
        elif action == "logrotate_force_plus_tmp_cleanup":
            subprocess.run(["logrotate", "-f", args.get("logrotate_conf", "/etc/logrotate.conf")],
                           capture_output=True, text=True, timeout=timeout)
            subprocess.run(["find", "/tmp", "-mtime", f"+{args.get('tmp_max_age_days', 7)}", "-delete"],
                           capture_output=True, text=True, timeout=timeout)
            success = True
        else:
            success = False
    except Exception as e:
        logging.warning(f"RECOVERY_EXCEPTION class={class_name} err={e}")
        success = False
    return success, action, time.time() - start


def verify_drift_dropped():
    try:
        r = subprocess.run(
            ["docker", "exec", POSTGRES_CONTAINER, "sh", "-c",
             "ps -o pcpu= -p $(pgrep -d, postgres 2>/dev/null) 2>/dev/null | awk '{s+=$1} END {print s+0}'"],
            capture_output=True, text=True, timeout=5)
        val = r.stdout.strip()
        return float(val) if val else None
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return None


def build_escalation_body(reason, class_name, avg, peak, dominant_query, recent_samples, *,
                          evidence="", recommended="", window="", stats_window=None,
                          action="", duration=None, trigger="persistent", facts=None, attribution=None,
                          owner=""):
    """PURE — asserted field by field in --self-test. `dominant_query` is the CUMULATIVE top-1, rendered
    labelled as such; the window attribution arrives as `attribution` lines (CH3 Req 6)."""
    lines = [
        f"🛑 POSTGRES_CPU_DRIFT_UNIFIED [trigger={trigger}, autopilot: {reason}]", "",
        instruments_line(facts or {}, avg),
        f"Point window: {window or window_text()} · peak {peak}% · recent {recent_samples} · "
        f"CRITICAL bypass: avg > {CRITICAL_BYPASS_AVG_PCT}% or peak > {CRITICAL_BYPASS_PEAK_PCT}%",
        f"Classified class: {class_name}" + (f" ({evidence})" if evidence else "")]
    if owner:
        lines.append(f"Owner: {owner}")
    if action:
        d = f"{duration:.2f}s" if duration is not None else "n-a"
        lines.append(f"Recovery attempted: {action} (duration={d})")
    lines += [""] + list(attribution or ["Window attribution: not computed for this invocation"]) + [
              f"Cumulative top-1 (pg_stat_statements, cumulative {stats_window or 'since an unknown stats_reset'}): "
              f"{(dominant_query or '<not_probed>')[:200]}",
              "",
              f"Action: dispatch {recommended or DEFAULT_RECOMMENDED_WAVE} via Cowork → Claude Code",
              f"Audit shape: {AUDIT_DOC}",
              f"Source log: {LOG_PATH}"]
    return "\n".join(lines)


def handle(args, registry, class_name, evidence, dominant_query, stats_window, dry_run, *,
           cumulative_query=None, attribution=None, facts=None):
    """Everything after classification. Prints the body when escalating; returns the exit code.
    `dominant_query` is what classify() was fed (the window top-1); the body's labelled cumulative line
    renders `cumulative_query` (defaulting to the same text for a caller that has only one)."""
    def escalate(reason, **kw):
        print(build_escalation_body(reason, class_name, args.avg, args.peak,
                                    dominant_query if cumulative_query is None else cumulative_query,
                                    args.recent_samples, evidence=evidence,
                                    recommended=recommended_wave(registry, class_name),
                                    stats_window=stats_window, trigger=args.trigger, facts=facts,
                                    attribution=attribution,
                                    owner=(find_class(registry, class_name) or {}).get("owner", ""), **kw))

    # Step 3: UNKNOWN → escalate
    if class_name == "UNKNOWN":
        escalate("UNKNOWN_CLASS")
        log_event(action="escalate_unknown", class_name="UNKNOWN", evidence=evidence,
                  avg=args.avg, peak=args.peak, exit_code=EXIT_ESCALATE, dry_run=dry_run)
        return EXIT_ESCALATE

    # Step 3b: a DECLARED diagnose-only class escalates by design. It is not a recovery, it did not
    # fail, and it must not spend the recovery ceilings.
    if (find_class(registry, class_name) or {}).get("recovery_action") == DIAGNOSE_ONLY:
        escalate("diagnose_only")
        log_event(action="escalate_diagnose_only", class_name=class_name, evidence=evidence,
                  avg=args.avg, peak=args.peak, exit_code=EXIT_ESCALATE, dry_run=dry_run)
        return EXIT_ESCALATE

    # Step 4: check ceilings (applies to a class with a real recovery action)
    tripped, reason = check_ceilings(class_name)
    if tripped:
        escalate(reason)
        log_event(action="escalate_ceiling_tripped", class_name=class_name, ceiling_reason=reason,
                  avg=args.avg, peak=args.peak, exit_code=EXIT_ESCALATE, dry_run=dry_run)
        return EXIT_ESCALATE

    # Step 5: dry-run mode → log + escalate (no actual recovery)
    if dry_run:
        log_event(action="dry_run_would_have_recovered", class_name=class_name,
                  avg=args.avg, peak=args.peak,
                  dominant_query=(dominant_query or "<class_override>")[:128],
                  dry_run=True, exit_code=EXIT_ESCALATE)
        escalate(f"DRY_RUN: would have recovered class={class_name}")
        return EXIT_ESCALATE

    # Step 6: execute recovery
    success, action_verb, duration = execute_recovery(class_name, registry)
    if not success:
        escalate(f"recovery_failed action={action_verb}", action=action_verb, duration=duration)
        update_class_state(class_name, success=False)
        log_event(action="recovery_failed", class_name=class_name, recovery_action=action_verb,
                  duration_s=duration, exit_code=EXIT_ESCALATE, dry_run=False)
        return EXIT_ESCALATE

    # Step 7: verify
    time.sleep(2)
    post_cpu = verify_drift_dropped()
    if post_cpu is not None and post_cpu < BASELINE_RECOVERED_PCT:
        update_class_state(class_name, success=True)
        log_event(action="silent_recovery", class_name=class_name, recovery_action=action_verb,
                  avg=args.avg, post_cpu=post_cpu, duration_s=duration,
                  exit_code=EXIT_SILENT, dry_run=False)
        return EXIT_SILENT
    escalate(f"recovery_attempted_but_drift_persists post_cpu={post_cpu}",
             action=action_verb, duration=duration)
    update_class_state(class_name, success=False)
    log_event(action="recovery_persisted", class_name=class_name, recovery_action=action_verb,
              post_cpu=post_cpu, duration_s=duration, exit_code=EXIT_ESCALATE, dry_run=False)
    return EXIT_ESCALATE


def make_parser():
    p = ArgParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter,
        epilog=(f"\nConstants (architect-ratified, no env overrides):\n"
                f"  CEILING_RECOVERIES_PER_24H = {CEILING_RECOVERIES_PER_24H}\n"
                f"  CEILING_CONSECUTIVE = {CEILING_CONSECUTIVE}\n"
                f"  CEILING_RECOVERY_DURATION_S = {CEILING_RECOVERY_DURATION_S}\n"
                f"  CEILING_COOLDOWN_S = {CEILING_COOLDOWN_S}\n"
                f"  CRITICAL_BYPASS_AVG_PCT = {CRITICAL_BYPASS_AVG_PCT}\n"
                f"  CRITICAL_BYPASS_PEAK_PCT = {CRITICAL_BYPASS_PEAK_PCT}\n"))
    p.add_argument("--avg", type=float, required=True)
    p.add_argument("--peak", type=float, default=0.0)
    p.add_argument("--recent-samples", type=str, default="")
    p.add_argument("--trigger", type=str, default="persistent", choices=["persistent", "trajectory", "both", "persistent_AND_trajectory"],
                   help="Which snapshot.sh condition fired this invocation (default persistent for backward compat with pre-OPS-POSTGRES-AUTOPILOT-UNIFIED-W1 callers)")
    return p


def main():
    args = make_parser().parse_args()
    if yaml is None:
        print("FATAL: pyyaml not installed", file=sys.stderr)
        sys.exit(EXIT_FRAMEWORK_ERROR)
    setup_logging()
    logging.info(f"START trigger={args.trigger} avg={args.avg} peak={args.peak} samples={args.recent_samples} "
                 f"window_n={os.environ.get('PG_CPU_WINDOW_N', '')}")

    dry_run = os.environ.get("DRY_RUN_AUTOPILOT", "0") == "1"
    class_override = os.environ.get("CLASS_OVERRIDE", "")

    # Step 1: CRITICAL_BYPASS (unconditional)
    if args.avg > CRITICAL_BYPASS_AVG_PCT or args.peak > CRITICAL_BYPASS_PEAK_PCT:
        msg = f"CRITICAL_BYPASS: avg={args.avg} > {CRITICAL_BYPASS_AVG_PCT} OR peak={args.peak} > {CRITICAL_BYPASS_PEAK_PCT}"
        log_event(action="critical_bypass", avg=args.avg, peak=args.peak,
                  exit_code=EXIT_CRITICAL_BYPASS, dry_run=dry_run)
        print(msg)
        sys.exit(EXIT_CRITICAL_BYPASS)

    # Step 2: class determination
    registry = load_registry()
    facts = parse_facts(os.environ.get("PG_CPU_FACTS"))
    dominant_query, evidence, stats_window = "", "", None
    cumulative_query, attribution = None, None
    if class_override:
        class_name, evidence = class_override, "CLASS_OVERRIDE"
        # synthetic class — ensure registry has it OR use noop
        if not registry:
            registry = {"classes": [{"name": class_name, "recovery_action": "noop"}]}
        elif not any(c.get("name") == class_name for c in registry.get("classes", [])):
            registry["classes"].append({"name": class_name, "recovery_action": "noop"})
    else:
        if registry is None:
            # AC1.6: registry not loaded yet (C1 fires before C2) → escalate as registry_not_loaded
            print(build_escalation_body("registry_not_loaded", "UNKNOWN", args.avg, args.peak,
                                        "<no_registry>", args.recent_samples,
                                        evidence="registry unreadable", trigger=args.trigger))
            log_event(action="escalate_no_registry", avg=args.avg, peak=args.peak,
                      exit_code=EXIT_ESCALATE, dry_run=dry_run)
            sys.exit(EXIT_ESCALATE)
        # registry loaded — the live probe stays the reachability check and the CUMULATIVE line
        top = probe_pg_stat_statements(top_n=3)
        if top is None:
            msg = "FRAMEWORK_ERROR: postgres_unreachable (pg_stat_statements probe failed)"
            log_event(action="framework_error", reason="postgres_unreachable",
                      avg=args.avg, exit_code=EXIT_FRAMEWORK_ERROR, dry_run=dry_run)
            print(msg)
            sys.exit(EXIT_FRAMEWORK_ERROR)
        cumulative_query = top[0][0] if top else ""
        stats_window = probe_stats_window()
        # classify() is fed the WINDOW top-1 over the window the firing leg used (CH3 Req 5)
        now = int(time.time())
        frm = facts.get("attribution_from_s")
        frm = int(frm) if isinstance(frm, (int, float)) and not isinstance(frm, bool) else now - 7 * 86400
        label = str(facts.get("attribution_label") or "the trailing 7 days")
        snaps, bad = load_pgss_window(pgss_dir(), frm, now)
        att = attribute(snaps)
        if bad and att["status"] != "ok":
            att["reason"] += f" ({bad} unparseable store file(s) skipped)"
        dominant_query, class_name, evidence = window_class(att, registry, label)
        attribution = attribution_lines(att, snaps[-1] if snaps else latest_pgss(pgss_dir()), label,
                                        facts.get("attribution_cpu_pct"))
        log_event(action="window_attribution", status=att["status"], label=label, snapshots=len(snaps),
                  bad_files=bad, class_name=class_name)

    sys.exit(handle(args, registry, class_name, evidence, dominant_query, stats_window, dry_run,
                    cumulative_query=cumulative_query, attribution=attribution, facts=facts))


# ── SELF-TEST ────────────────────────────────────────────────────────────────────────────────────
# Hermetic: STATE_DIR is repointed into a temp dir BEFORE any scenario, no DB is reached (every
# scenario hands `handle()` its classification), and no logging is configured, so log_event()
# writes nowhere. The fixture query is the real 2026-09-28 dominant query, verbatim.
SELFTEST_EXPECTED = 51
REAL_DOMINANT_QUERY = ("SELECT funding_rate FROM funding_history WHERE coin = $1 AND recorded_at >= $2 "
                       "ORDER BY recorded_at")


def self_test():
    global STATE_DIR
    results = []

    def check(desc, cond):
        results.append(bool(cond))
        if not cond:
            print(f"  FAIL: {desc}")

    def run_handle(class_name, evidence, query, stats_window, dry_run=False):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = handle(args, reg, class_name, evidence, query, stats_window, dry_run)
        return code, out.getvalue()

    reg = {"classes": [
        dict(name="fixture-regex", classifier_type="pg_query_regex", classifier_regex="funding_stats_14d",
             recovery_action="psql_refresh_matview", recommended_wave_template="OPS-FIXTURE-REGEX-W{NEXT}"),
        dict(name="fixture-diag", classifier_type="pg_query_regex", classifier_regex="FROM funding_history",
             recovery_action="escalate", recommended_wave_template="OPS-FIXTURE-DIAG-W{NEXT}"),
        dict(name="fixture-proc-absent", classifier_type="process_count",
             classifier_args={"pattern": "no-such-process-pgcpu-selftest-zz9", "max_concurrent": 0},
             recovery_action="escalate"),
        dict(name="UNKNOWN", classifier_type="catchall", recovery_action="escalate",
             recommended_wave_template="OPS-FIXTURE-UNKNOWN-W{NEXT}")]}
    args = types.SimpleNamespace(avg=10.46, peak=37.68, recent_samples="7.24,1.90,16.11", trigger="persistent")
    saved_state_dir = STATE_DIR
    saved_env = {k: os.environ.get(k) for k in ("PG_CPU_WINDOW_N", "PG_CPU_WINDOW_SPAN")}
    tmp = tempfile.mkdtemp(prefix="pgcpu-autopilot-selftest.")
    STATE_DIR = Path(tmp) / "state"
    try:
        os.environ["PG_CPU_WINDOW_N"] = "28"
        os.environ["PG_CPU_WINDOW_SPAN"] = "2026-09-22T06:48:03Z..2026-09-29T00:48:02Z"

        # C1 — classification, registry order, and the evidence it carries
        name, ev = classify(REAL_DOMINANT_QUERY, reg)
        check("C1 the real dominant query → the first matching row", name == "fixture-diag")
        check("C1 evidence names what matched", ev == "pg_query_regex matched the window top-1 statement")
        check("C1 no match (the absent-process row cannot fire) → UNKNOWN",
              classify("SELECT 1", reg) == ("UNKNOWN", "no registry class matched"))
        # A CHILD with a unique argv, never this process: BSD pgrep excludes the caller's ancestors.
        marker = f"pgcpu-selftest-marker-{os.getpid()}"
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", marker])
        try:
            self_row = {"classes": [dict(name="fixture-self", classifier_type="process_count",
                                         classifier_args={"pattern": marker, "max_concurrent": 0},
                                         recovery_action="escalate")]}
            name, ev = classify("SELECT 1", self_row)
        finally:
            child.kill()
            child.wait()
        check("C1 process_count renders the MEASURED count (a saturated class announces itself)",
              name == "fixture-self" and re.fullmatch(r"process_count=\d+ > max_concurrent=0", ev))
        check("C1 empty registry → UNKNOWN, said so", classify("x", {}) == ("UNKNOWN", "no registry classes loaded"))

        # C2 — a DECLARED diagnose-only class: the exact shape of the 2026-09-28 page
        code, out = run_handle("fixture-diag", "pg_query_regex matched the window top-1 statement", REAL_DOMINANT_QUERY,
                               "since 2026-06-05, 116d")
        check("C2 escalates (exit 1)", code == EXIT_ESCALATE)
        check("C2 header says diagnose_only, never recovery_failed",
              "autopilot: diagnose_only]" in out and "recovery_failed" not in out)
        check("C2 no 'Recovery attempted' line for a non-recovery", "Recovery attempted" not in out)
        check("C2 Action is read from the classified row", "Action: dispatch OPS-FIXTURE-DIAG-W{NEXT} via" in out)
        check("C2 the point window is rendered",
              "Point window: 28 samples (2026-09-22T06:48:03Z..2026-09-29T00:48:02Z) · peak 37.68%" in out)
        check("C2 the classifier evidence is rendered",
              "Classified class: fixture-diag (pg_query_regex matched the window top-1 statement)" in out)
        check("C2 the cumulative top-1 is LABELLED cumulative, with its stats window",
              "Cumulative top-1 (pg_stat_statements, cumulative since 2026-06-05, 116d): SELECT funding_rate" in out)
        check("C2 the audit line cites the doc that exists",
              f"Audit shape: {AUDIT_DOC}\n" in out and "OPS-POSTGRES-CPU-AUTOPILOT-W1-endpoint-truth" not in out)
        check("C2 diagnose-only spends NO recovery ceiling", not (STATE_DIR / "fixture-diag").exists())

        # C3 — UNKNOWN: its own row's template; an unknown stats window is said, not hidden
        code, out = run_handle("UNKNOWN", "no registry class matched", "SELECT 1", None)
        check("C3 UNKNOWN escalates", code == EXIT_ESCALATE and "autopilot: UNKNOWN_CLASS]" in out)
        check("C3 UNKNOWN's Action comes from the UNKNOWN row", "Action: dispatch OPS-FIXTURE-UNKNOWN-W{NEXT} via" in out)
        check("C3 an unknown stats window is stated", "cumulative since an unknown stats_reset" in out)
        check("C3 no ceiling state", not (STATE_DIR / "UNKNOWN").exists())

        # C4 — a class with a REAL recovery action still takes the recovery path (dry-run: nothing runs)
        code, out = run_handle("fixture-regex", "pg_query_regex matched the window top-1 statement", "funding_stats_14d", None,
                               dry_run=True)
        check("C4 recovery class → DRY_RUN body, exit 1",
              code == EXIT_ESCALATE and "autopilot: DRY_RUN: would have recovered class=fixture-regex]" in out)
        check("C4 its Action comes from its own row", "Action: dispatch OPS-FIXTURE-REGEX-W{NEXT} via" in out)

        # C5 — no window from the caller (a pre-fix snapshot.sh) → said, not invented
        for k in ("PG_CPU_WINDOW_N", "PG_CPU_WINDOW_SPAN"):
            os.environ.pop(k, None)
        body = build_escalation_body("x", "UNKNOWN", 1.0, 2.0, "q", "1,2,3")
        check("C5 an unreported window is stated", "Point window: an unreported window" in body)
        check("C5 no registry → the fallback Action constant", recommended_wave(None, "anything") == DEFAULT_RECOMMENDED_WAVE)
        check("C5 every Action is a template, never a hardcoded wave number",
              re.search(r"-W\d", body) is None and "-W{NEXT}" in body)

        # ── WINDOW ATTRIBUTION (OPS-ALARM-OWNER-DERIVATION-W1 CH3) ──────────────────────────────
        def snap(ts, q, reset="2026-06-05T00:23:51Z", texts=None, active=None):
            return {"ts": ts, "stats_reset": reset, "q": q, "texts": texts or {}, "active": active or []}
        T0 = 1791000000
        TX = {"1": "SELECT funding_rate FROM funding_history WHERE coin = $1", "2": "UPDATE directional_labels SET x = $1",
              "3": "SELECT 1"}
        # The DISAGREEMENT fixture: statement 1 owns the cumulative rank (8e9 ms since June) but barely ran
        # in the window; statement 2 burned 9e6 ms inside it.
        s0 = snap(T0, {"1": (100, 8.0e9), "2": (10, 1.0e5), "3": (5, 1.0)}, texts=TX)
        s1 = snap(T0 + 21600, {"1": (101, 8.0e9 + 2.0e4), "2": (900, 1.0e5 + 4.0e6), "3": (6, 2.0)}, texts=TX)
        s2 = snap(T0 + 43200, {"1": (102, 8.0e9 + 4.0e4), "2": (1800, 1.0e5 + 9.0e6), "3": (7, 3.0)}, texts=TX,
                  active=[dict(pid="7", state="active", wait="", dur_s="12", query_id="2", text="UPDATE directional_labels SET x = ?")])
        att = attribute([s0, s1, s2])
        cumulative_top = max(s2["q"], key=lambda k: s2["q"][k][1])
        check("A1 Δ ranking beats the cumulative rank on a fixture where they disagree",
              att["status"] == "ok" and att["top"][0]["qid"] == "2" and cumulative_top == "1")
        check("A1 Σ Δ over consecutive pairs, with shares",
              att["top"][0]["ms"] == 9.0e6 and round(att["top"][0]["share"], 1) == 99.6)
        check("A1 the last interval is ranked on its own pair", att["last"][0]["qid"] == "2" and att["last"][0]["ms"] == 5.0e6)
        # eviction: statement 2's calls FELL between s1 and s2 — that pair's delta is dropped, not invented
        s2e = snap(T0 + 43200, {"1": (102, 8.0e9 + 4.0e4), "2": (3, 7.0e3), "3": (7, 3.0)}, texts=TX)
        att_e = attribute([s0, s1, s2e])
        check("A2 eviction (calls fell) drops that pair's delta", att_e["top"][0]["qid"] == "2" and att_e["top"][0]["ms"] == 4.0e6)
        check("A2 a statement absent from the previous snapshot counts its whole total",
              pair_deltas(snap(0, {}), snap(1, {"9": (4, 50.0)})) == {"9": 50.0})
        # a stats_reset inside the window drops the window: INDETERMINATE, class UNKNOWN, and the body says why
        att_r = attribute([s0, snap(T0 + 21600, {"1": (1, 5.0)}, reset="2026-10-10T00:00:00Z")])
        _, cls_r, ev_r = window_class(att_r, reg, "the trailing 7 days")
        check("A3 stats_reset change in window → INDETERMINATE + UNKNOWN, said why",
              att_r["status"] == "indeterminate" and cls_r == "UNKNOWN" and "stats_reset changed inside the window" in ev_r)
        check("A3 one snapshot is no window", attribute([s0])["status"] == "indeterminate")
        stmt, cls_w, ev_w = window_class(att, reg, "the trailing 7 days")
        check("A4 classify() is fed the WINDOW top-1, not the cumulative one",
              stmt == TX["2"] and cls_w == "UNKNOWN" and ev_w.endswith("; window: the trailing 7 days"))
        lines = attribution_lines(att, s2, "the trailing 7 days")
        facts = {"persistent_instrument": "integral", "integral_mean": 112.4, "integral_coverage_pct": 84.2,
                 "integral_persistent_pct": 100, "provisional_until": "2026-10-25", "point_mean": 10.46,
                 "point_baseline_pct": 10}
        body = build_escalation_body("UNKNOWN_CLASS", "UNKNOWN", 10.46, 37.68, REAL_DOMINANT_QUERY, "7.24,1.90,16.11",
                                     stats_window="since 2026-06-05, 128d", facts=facts, attribution=lines)
        check("A5 body: the window top-3 by Δexec, with ms and share",
              "Window top-3 by Δexec (the trailing 7 days, " in body and "1) 9,000,000 ms (99.6%) UPDATE directional_labels" in body)
        check("A5 body: the last-interval top-3", "Last-interval top-3 by Δexec (" in body and "5,000,000 ms" in body)
        check("A5 body: active at the sample instant, through the normalised text",
              "Active at the sample instant (" in body and "1 non-idle backend(s): active 12s UPDATE directional_labels SET x = $1" in body)
        check("A5 body: the cumulative top-1, labelled", "Cumulative top-1 (pg_stat_statements, cumulative since 2026-06-05, 128d): SELECT funding_rate" in body)
        check("A5 body: both instruments side by side",
              "7-day mean (integral, cgroup usage_usec, coverage 84.2%): 112.4% vs 100% (provisional until 2026-10-25) · "
              "28-instant mean (point, docker stats median-of-30 @ :47): 10.46% vs 10% (reported, decides nothing)" in body)
        q7 = attribute([snap(T0, {"1": (1, 0.0)}), snap(T0 + 3600, {"1": (2, 144000.0)})])
        check("A9 statement time vs container CPU: 4 % vs 50 % renders 8.0 %, statement-time named",
              "Σ Δexec = 4.0 % of one core vs container CPU 50.0 % of one core (integral, same window) → 8.0 % of it; "
              "the class names the top STATEMENT-time consumer, not the top CPU consumer" in statement_share_line(q7, "w", 50.0)
              and statement_share_line(q7, "w", 50.0) in attribution_lines(q7, None, "w", 50.0))
        check("A9 no integral over the window renders n/a, never a guess",
              "container CPU n/a (no covered integral segment) (integral, same window) → n/a of it" in statement_share_line(q7, "w", None))
        check("A5 body: no instrument facts → said, never assumed",
              "7-day mean (integral): not reported by the caller" in build_escalation_body("x", "UNKNOWN", 1.0, 2.0, "q", "1"))
        # the store: atomic one-file write, round trip, texts ∪ top-by-delta, literals stripped, wall-time trim
        store = Path(tmp) / "pgss"
        store.mkdir()
        old_file = store / (_stamp(T0 - 9 * 86400) + ".tsv")
        old_file.write_text(serialize_pgss(snap(T0 - 9 * 86400, {"2": (1, 1.0)})))
        (store / "README.keep").write_text("not a snapshot")
        (store / (_stamp(T0 - 3600) + ".tsv")).write_text(serialize_pgss(snap(T0 - 3600, {"2": (10, 1.0e5)})))
        answers = {
            "pg_stat_statements_info": ("2026-06-05T00:23:51Z", 0),
            "total_exec_time FROM": ("1|100|8000000000.0\n2|900|4100000.0\n3|6|2.0\n", 0),
            "WHERE queryid IN": ("1|SELECT funding_rate FROM funding_history\n2|UPDATE directional_labels SET x = $1\n", 0),
            "pg_stat_activity": ("7|active||12|2|UPDATE directional_labels SET note = 'secret-ish' WHERE id = 42\n", 0)}
        def fake_run(sql, timeout=10):
            return next(v for k, v in answers.items() if k in sql)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = record_pgss(env={"PG_CPU_PGSS_DIR": str(store)}, now=T0, run=fake_run)
        files = sorted(p.name for p in store.iterdir() if PGSS_NAME_RE.match(p.name))
        check("A6 --record-pgss prints PGSS_RECORD=ok and exits 0", rc == 0 and out.getvalue().startswith("PGSS_RECORD=ok "))
        check("A6 exactly one new file, named by its instant; the 9-day-old one trimmed by WALL time, nothing else touched",
              files == [_stamp(T0 - 3600) + ".tsv", _stamp(T0) + ".tsv"] and (store / "README.keep").exists())
        got = parse_pgss((store / (_stamp(T0) + ".tsv")).read_text())
        check("A6 the file round-trips: full set, stats_reset, texts", got["q"]["2"] == (900, 4100000.0)
              and got["stats_reset"] == "2026-06-05T00:23:51Z" and got["texts"]["2"].startswith("UPDATE directional_labels"))
        check("A6 no literal survives from pg_stat_activity",
              got["active"][0]["text"] == "UPDATE directional_labels SET note = '?' WHERE id = ?")
        check("A6 no temp file left behind", not any(p.name.endswith(".tmp") for p in store.iterdir()))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = record_pgss(env={"PG_CPU_PGSS_DIR": str(store)}, now=T0 + 60, run=lambda sql, timeout=10: (None, 1))
        check("A6 an unreadable database → PGSS_RECORD=failed, exit 3, no file",
              rc == EXIT_FRAMEWORK_ERROR and out.getvalue().startswith("PGSS_RECORD=failed ")
              and not (store / (_stamp(T0 + 60) + ".tsv")).exists())
        (store / (_stamp(T0 + 120) + ".tsv")).write_text("garbage")
        snaps_w, bad_w = load_pgss_window(store, T0 - 7200, T0 + 3600)
        check("A7 the window loader keeps [from, to], oldest first, and COUNTS what it could not parse",
              [x["ts"] for x in snaps_w] == [T0 - 3600, T0] and bad_w == 1)
        check("A7 a tab or newline in a statement cannot break a store line",
              parse_pgss(serialize_pgss(snap(1, {"5": (1, 1.0)}, texts={"5": "SELECT\t1\nFROM x"})))["texts"]["5"] == "SELECT 1 FROM x")
        check("A8 facts: unreadable JSON is {}, never a guess", parse_facts("not json") == {} and parse_facts("[1]") == {})

        # C6 — bad argv is FRAMEWORK_ERROR, never argparse's 2 (= CRITICAL_BYPASS downstream)
        for argv, desc in ((["--bogus"], "unknown flag"), ([], "missing --avg")):
            err = io.StringIO()
            try:
                with contextlib.redirect_stderr(err):
                    make_parser().parse_args(argv)
                code = None
            except SystemExit as e:
                code = e.code
            check(f"C6 {desc} → exit {EXIT_FRAMEWORK_ERROR}", code == EXIT_FRAMEWORK_ERROR)
        check("C6 --help still exits 0", _help_exit_code() == 0)
    except Exception as e:  # an assertion that raises is not an assertion — count it as a FAIL
        check(f"self-test raised {type(e).__name__}: {e}", False)
    finally:
        STATE_DIR = saved_state_dir
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(tmp, ignore_errors=True)

    failed = results.count(False)
    if failed == 0 and len(results) != SELFTEST_EXPECTED:
        print(f"SELF-TEST: INDETERMINATE — ran {len(results)} assertions, expected {SELFTEST_EXPECTED}")
        print("POSTGRES_CPU_AUTOPILOT_SELFTEST_VERDICT=INDETERMINATE")
        return EXIT_FRAMEWORK_ERROR
    if failed:
        print(f"SELF-TEST: FAIL ({failed} of {len(results)})")
        print("POSTGRES_CPU_AUTOPILOT_SELFTEST_VERDICT=FAIL")
        return 1
    print(f"SELF-TEST: PASS ({len(results)} assertions)")
    print("POSTGRES_CPU_AUTOPILOT_SELFTEST_VERDICT=PASS")
    return 0


def _help_exit_code():
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            make_parser().parse_args(["--help"])
    except SystemExit as e:
        return e.code
    return None


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        sys.exit(self_test())
    if sys.argv[1:] == ["--record-pgss"]:   # before argparse: this mode takes no --avg
        sys.exit(record_pgss())
    main()

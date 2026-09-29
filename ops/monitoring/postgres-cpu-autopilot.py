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

  postgres-cpu-autopilot.py --self-test    # hermetic: no DB, no host path, no yaml needed
"""
from __future__ import annotations

import argparse, contextlib, io, json, logging, os, re, shutil, subprocess, sys, tempfile, time, types
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
                return name, "pg_query_regex matched the top-1 query"
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
                          action="", duration=None, trigger="persistent"):
    """PURE — asserted field by field in --self-test."""
    lines = [
        f"🛑 POSTGRES_CPU_DRIFT_UNIFIED [trigger={trigger}, autopilot: {reason}]", "",
        f"Rolling avg: {avg}% over {window or window_text()} "
        f"(CRITICAL bypass threshold: > {CRITICAL_BYPASS_AVG_PCT}%, peak: {peak}%)",
        f"Recent samples: {recent_samples}",
        f"Classified class: {class_name}" + (f" ({evidence})" if evidence else "")]
    if action:
        d = f"{duration:.2f}s" if duration is not None else "n-a"
        lines.append(f"Recovery attempted: {action} (duration={d})")
    lines += ["",
              f"Dominant query (pg_stat_statements top-1, cumulative {stats_window or 'since an unknown stats_reset'}): "
              f"{(dominant_query or '<not_probed>')[:200]}",
              "",
              f"Action: dispatch {recommended or DEFAULT_RECOMMENDED_WAVE} via Cowork → Claude Code",
              f"Audit shape: {AUDIT_DOC}",
              f"Source log: {LOG_PATH}"]
    return "\n".join(lines)


def handle(args, registry, class_name, evidence, dominant_query, stats_window, dry_run):
    """Everything after classification. Prints the body when escalating; returns the exit code."""
    def escalate(reason, **kw):
        print(build_escalation_body(reason, class_name, args.avg, args.peak, dominant_query,
                                    args.recent_samples, evidence=evidence,
                                    recommended=recommended_wave(registry, class_name),
                                    stats_window=stats_window, trigger=args.trigger, **kw))

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
    dominant_query, evidence, stats_window = "", "", None
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
        # registry loaded — probe DB to find dominant query
        top = probe_pg_stat_statements(top_n=3)
        if top is None:
            msg = "FRAMEWORK_ERROR: postgres_unreachable (pg_stat_statements probe failed)"
            log_event(action="framework_error", reason="postgres_unreachable",
                      avg=args.avg, exit_code=EXIT_FRAMEWORK_ERROR, dry_run=dry_run)
            print(msg)
            sys.exit(EXIT_FRAMEWORK_ERROR)
        dominant_query = top[0][0] if top else ""
        stats_window = probe_stats_window()
        class_name, evidence = classify(dominant_query, registry)

    sys.exit(handle(args, registry, class_name, evidence, dominant_query, stats_window, dry_run))


# ── SELF-TEST ────────────────────────────────────────────────────────────────────────────────────
# Hermetic: STATE_DIR is repointed into a temp dir BEFORE any scenario, no DB is reached (every
# scenario hands `handle()` its classification), and no logging is configured, so log_event()
# writes nowhere. The fixture query is the real 2026-09-28 dominant query, verbatim.
SELFTEST_EXPECTED = 26
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
        check("C1 evidence names what matched", ev == "pg_query_regex matched the top-1 query")
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
        code, out = run_handle("fixture-diag", "pg_query_regex matched the top-1 query", REAL_DOMINANT_QUERY,
                               "since 2026-06-05, 116d")
        check("C2 escalates (exit 1)", code == EXIT_ESCALATE)
        check("C2 header says diagnose_only, never recovery_failed",
              "autopilot: diagnose_only]" in out and "recovery_failed" not in out)
        check("C2 no 'Recovery attempted' line for a non-recovery", "Recovery attempted" not in out)
        check("C2 Action is read from the classified row", "Action: dispatch OPS-FIXTURE-DIAG-W{NEXT} via" in out)
        check("C2 the window is rendered",
              "Rolling avg: 10.46% over 28 samples (2026-09-22T06:48:03Z..2026-09-29T00:48:02Z)" in out)
        check("C2 the classifier evidence is rendered",
              "Classified class: fixture-diag (pg_query_regex matched the top-1 query)" in out)
        check("C2 the pg_stat_statements window is disclosed",
              "(pg_stat_statements top-1, cumulative since 2026-06-05, 116d)" in out)
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
        code, out = run_handle("fixture-regex", "pg_query_regex matched the top-1 query", "funding_stats_14d", None,
                               dry_run=True)
        check("C4 recovery class → DRY_RUN body, exit 1",
              code == EXIT_ESCALATE and "autopilot: DRY_RUN: would have recovered class=fixture-regex]" in out)
        check("C4 its Action comes from its own row", "Action: dispatch OPS-FIXTURE-REGEX-W{NEXT} via" in out)

        # C5 — no window from the caller (a pre-fix snapshot.sh) → said, not invented
        for k in ("PG_CPU_WINDOW_N", "PG_CPU_WINDOW_SPAN"):
            os.environ.pop(k, None)
        body = build_escalation_body("x", "UNKNOWN", 1.0, 2.0, "q", "1,2,3")
        check("C5 an unreported window is stated", "over an unreported window" in body)
        check("C5 no registry → the fallback Action constant", recommended_wave(None, "anything") == DEFAULT_RECOMMENDED_WAVE)
        check("C5 every Action is a template, never a hardcoded wave number",
              re.search(r"-W\d", body) is None and "-W{NEXT}" in body)

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
    main()

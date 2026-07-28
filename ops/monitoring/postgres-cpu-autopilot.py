#!/usr/bin/env python3
"""postgres-cpu-autopilot.py — OPS-POSTGRES-CPU-AUTOPILOT-W1

Detect → Classify → Recover → Verify → Escalate state machine.
Invoked by postgres-cpu-snapshot.sh when rolling avg > BASELINE_PCT (10%).
Reads pg_stat_statements via psql shell-out as algovault_autopilot (role).
Classifies dominant query against registry; if known fix-shape, executes
idempotent recovery; verifies CPU drops < BASELINE_RECOVERED_PCT (15%);
else escalates via wrapper.

Exit codes:
  0 = SILENT recovery succeeded (snapshot.sh skips wrapper)
  1 = ESCALATE (autopilot emits body to stdout)
  2 = CRITICAL_BYPASS (avg > 50% OR peak > 90%)
  3 = FRAMEWORK_ERROR (DB unreachable, registry malformed, etc.)

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
"""
from __future__ import annotations

import argparse, json, logging, os, re, subprocess, sys, time
from pathlib import Path

try:
    import yaml
except ImportError:
    print("FATAL: pyyaml not installed", file=sys.stderr); sys.exit(3)

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

# Exit codes
EXIT_SILENT = 0
EXIT_ESCALATE = 1
EXIT_CRITICAL_BYPASS = 2
EXIT_FRAMEWORK_ERROR = 3


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


def _process_count_exceeds(pattern, max_concurrent):
    try:
        r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True, timeout=3)
        return len([l for l in r.stdout.split("\n") if l.strip()]) > max_concurrent
    except (subprocess.TimeoutExpired, OSError, FileNotFoundError):
        return False


def _cron_daemon_hung(unit):
    try:
        r = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True, timeout=3)
        return r.stdout.strip() != "active"
    except (subprocess.TimeoutExpired, OSError, FileNotFoundError):
        return False


def _disk_usage_exceeds(path, threshold_pct):
    try:
        r = subprocess.run(["df", "--output=pcent", path], capture_output=True, text=True, timeout=3)
        for line in r.stdout.split("\n"):
            line = line.strip().rstrip("%")
            if line.isdigit() and int(line) > threshold_pct:
                return True
    except (subprocess.TimeoutExpired, OSError, FileNotFoundError):
        pass
    return False


def classify(dominant_query, registry):
    if not registry or not registry.get("classes"):
        return "UNKNOWN"
    for cls in registry["classes"]:
        if cls.get("name") == "UNKNOWN":
            continue
        ctype = cls.get("classifier_type", "pg_query_regex")
        if ctype == "pg_query_regex":
            regex = cls.get("classifier_regex", "")
            if regex and re.search(regex, dominant_query, re.IGNORECASE):
                return cls["name"]
        elif ctype == "process_count":
            a = cls.get("classifier_args", {})
            if _process_count_exceeds(a.get("pattern", ""), a.get("max_concurrent", 1)):
                return cls["name"]
        elif ctype == "systemctl_status":
            a = cls.get("classifier_args", {})
            if _cron_daemon_hung(a.get("unit", "cron.service")):
                return cls["name"]
        elif ctype == "disk_usage":
            a = cls.get("classifier_args", {})
            if _disk_usage_exceeds(a.get("path", "/"), a.get("threshold_pct", 90)):
                return cls["name"]
    return "UNKNOWN"


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
    cls = next((c for c in registry["classes"] if c["name"] == class_name), None)
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


def emit_escalation_body(reason, class_name, avg, peak, dominant_query, recent_samples,
                         action="", duration=None, trigger="persistent"):
    lines = [
        f"🛑 POSTGRES_CPU_DRIFT_UNIFIED [trigger={trigger}, autopilot: {reason}]", "",
        f"Rolling avg: {avg}% (CRITICAL bypass threshold: > {CRITICAL_BYPASS_AVG_PCT}%, peak: {peak}%)",
        f"Recent samples: {recent_samples}",
        f"Classified class: {class_name}"]
    if action:
        d = f"{duration:.2f}s" if duration is not None else "n-a"
        lines.append(f"Recovery attempted: {action} (duration={d})")
    lines += ["",
              f"Dominant query (pg_stat_statements top-1): {(dominant_query or '<not_probed>')[:200]}",
              "",
              f"Action: dispatch OPS-POSTGRES-AUTOPILOT-MANIFEST-EXPAND-W{{NEXT}} via Cowork → Claude Code",
              "Audit shape: audits/OPS-POSTGRES-CPU-AUTOPILOT-W1-endpoint-truth.md",
              f"Source log: {LOG_PATH}"]
    print("\n".join(lines))


def main():
    p = argparse.ArgumentParser(
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
    args = p.parse_args()
    setup_logging()
    logging.info(f"START trigger={args.trigger} avg={args.avg} peak={args.peak} samples={args.recent_samples}")

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
    dominant_query = ""
    if class_override:
        class_name = class_override
        # synthetic class — ensure registry has it OR use noop
        if not registry:
            registry = {"classes": [{"name": class_name, "recovery_action": "noop"}]}
        elif not any(c.get("name") == class_name for c in registry.get("classes", [])):
            registry["classes"].append({"name": class_name, "recovery_action": "noop"})
    else:
        if registry is None:
            # AC1.6: registry not loaded yet (C1 fires before C2) → escalate as registry_not_loaded
            emit_escalation_body("registry_not_loaded", "UNKNOWN", args.avg, args.peak,
                                 "<no_registry>", args.recent_samples, trigger=args.trigger)
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
        class_name = classify(dominant_query, registry)

    # Step 3: UNKNOWN → escalate
    if class_name == "UNKNOWN":
        emit_escalation_body("UNKNOWN_CLASS", "UNKNOWN", args.avg, args.peak,
                             dominant_query, args.recent_samples, trigger=args.trigger)
        log_event(action="escalate_unknown", class_name="UNKNOWN",
                  avg=args.avg, peak=args.peak, exit_code=EXIT_ESCALATE, dry_run=dry_run)
        sys.exit(EXIT_ESCALATE)

    # Step 4: check ceilings (applies to known class)
    tripped, reason = check_ceilings(class_name)
    if tripped:
        emit_escalation_body(reason, class_name, args.avg, args.peak,
                             dominant_query, args.recent_samples, trigger=args.trigger)
        log_event(action="escalate_ceiling_tripped", class_name=class_name, ceiling_reason=reason,
                  avg=args.avg, peak=args.peak, exit_code=EXIT_ESCALATE, dry_run=dry_run)
        sys.exit(EXIT_ESCALATE)

    # Step 5: dry-run mode → log + escalate (no actual recovery)
    if dry_run:
        log_event(action="dry_run_would_have_recovered", class_name=class_name,
                  avg=args.avg, peak=args.peak,
                  dominant_query=(dominant_query or "<class_override>")[:128],
                  dry_run=True, exit_code=EXIT_ESCALATE)
        emit_escalation_body(f"DRY_RUN: would have recovered class={class_name}",
                             class_name, args.avg, args.peak, dominant_query, args.recent_samples, trigger=args.trigger)
        sys.exit(EXIT_ESCALATE)

    # Step 6: execute recovery
    success, action_verb, duration = execute_recovery(class_name, registry)
    if not success:
        emit_escalation_body(f"recovery_failed action={action_verb}",
                             class_name, args.avg, args.peak, dominant_query, args.recent_samples,
                             action=action_verb, duration=duration, trigger=args.trigger)
        update_class_state(class_name, success=False)
        log_event(action="recovery_failed", class_name=class_name, recovery_action=action_verb,
                  duration_s=duration, exit_code=EXIT_ESCALATE, dry_run=False)
        sys.exit(EXIT_ESCALATE)

    # Step 7: verify
    time.sleep(2)
    post_cpu = verify_drift_dropped()
    if post_cpu is not None and post_cpu < BASELINE_RECOVERED_PCT:
        update_class_state(class_name, success=True)
        log_event(action="silent_recovery", class_name=class_name, recovery_action=action_verb,
                  avg=args.avg, post_cpu=post_cpu, duration_s=duration,
                  exit_code=EXIT_SILENT, dry_run=False)
        sys.exit(EXIT_SILENT)
    else:
        emit_escalation_body(f"recovery_attempted_but_drift_persists post_cpu={post_cpu}",
                             class_name, args.avg, args.peak, dominant_query, args.recent_samples,
                             action=action_verb, duration=duration, trigger=args.trigger)
        update_class_state(class_name, success=False)
        log_event(action="recovery_persisted", class_name=class_name, recovery_action=action_verb,
                  post_cpu=post_cpu, duration_s=duration, exit_code=EXIT_ESCALATE, dry_run=False)
        sys.exit(EXIT_ESCALATE)


if __name__ == "__main__":
    main()

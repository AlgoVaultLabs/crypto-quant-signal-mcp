#!/usr/bin/env python3
"""WEBHOOK-HARDENING-W1 C4 — webhook delivery-health canary.

Host-side (Hetzner /opt/algovault-monitoring/) sustained-drift detector for the
outbound webhook delivery service. Reads `webhook_deliveries` + `webhook_subscriptions`
(read-only via `docker exec ... psql -U algovault_autopilot`) and fires an
operator-action-required Telegram alert ONLY on SUSTAINED drift — never per
failure. 6th consumer of `send_telegram.sh`; it does NOT re-implement the
severity/cooldown/DRY_RUN/fail-open gates (the wrapper owns those).

Alert contract (Claude files/monitoring-runbook.md): severity=CRITICAL_PERSISTENT
only; 24h cooldown per alert_id (wrapper); fail-open (exit 0 on ALL errors);
DRY_RUN_TG=1 routes through every gate but skips the POST. recommended_wave uses
the OPS-WEBHOOK-DELIVERY-<CLASS>-W{NEXT} template (NO literal Wn — the wrapper's
send-time resolver fills {NEXT} from status.md).

Drift classes (priority order): AUTO-DISABLED (a subscription auto-disabled) >
DEAD-SPIKE (dead deliveries in window >= threshold) > FAILED-RATE (failed-rate
>= threshold with min volume). Sustained = breach on >= SUSTAINED_CYCLES
consecutive runs (consecutive-breach counter in .alert-state/).

Test seams (env): WEBHOOK_CANARY_FORCE_{DEAD,FAILED,TOTAL,DISABLED} override the
measured metric; WEBHOOK_CANARY_SUSTAINED_CYCLES / _WINDOW_HOURS / thresholds
override config; DRY_RUN_TG=1 for the smoke.
"""
import os
import subprocess
import sys
import time

ALERT_ID = "WEBHOOK_DELIVERY_DRIFT"
WRAPPER = "/opt/algovault-monitoring/send_telegram.sh"
STATE_DIR = "/opt/algovault-monitoring/.alert-state"
BREACH_COUNT_FILE = os.path.join(STATE_DIR, "webhook-delivery-canary-breach.count")
LOG = "/var/log/algovault-webhook-delivery-canary.log"
PG_CONTAINER = "crypto-quant-signal-mcp-postgres-1"
PG_ROLE = "algovault_autopilot"
PG_DB = "signal_performance"
AUDIT_DOC = "audits/WEBHOOK-HARDENING-W1-endpoint-truth.md"


def _int_env(name, default):
    try:
        v = int(os.environ[name])
        return v if v >= 0 else default
    except (KeyError, ValueError):
        return default


def _float_env(name, default):
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


# Config (env-overridable for smokes; defaults are the prod policy).
WINDOW_HOURS = _int_env("WEBHOOK_CANARY_WINDOW_HOURS", 24)
DEAD_THRESHOLD = _int_env("WEBHOOK_CANARY_DEAD_THRESHOLD", 10)
FAILED_RATE_THRESHOLD = _float_env("WEBHOOK_CANARY_FAILED_RATE_THRESHOLD", 0.5)
MIN_VOLUME = _int_env("WEBHOOK_CANARY_MIN_VOLUME", 20)
DISABLED_THRESHOLD = _int_env("WEBHOOK_CANARY_DISABLED_THRESHOLD", 1)
SUSTAINED_CYCLES = max(1, _int_env("WEBHOOK_CANARY_SUSTAINED_CYCLES", 3))


def log(msg):
    line = "%s webhook-delivery-canary: %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg)
    print(line)
    try:
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def read_breach_count():
    try:
        with open(BREACH_COUNT_FILE) as fh:
            return int(fh.read().strip() or "0")
    except (OSError, ValueError):
        return 0


def write_breach_count(n):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(BREACH_COUNT_FILE, "w") as fh:
            fh.write(str(n))
    except OSError as e:
        log("WARN: could not persist breach count: %s" % e)


def query_metrics():
    """Return (dead, failed, total, disabled) over the rolling window. Test seams override."""
    cutoff = int(time.time()) - WINDOW_HOURS * 3600
    sql = (
        "SELECT "
        "(SELECT count(*) FROM webhook_deliveries WHERE status='dead' AND created_at >= %d), "
        "(SELECT count(*) FROM webhook_deliveries WHERE status IN ('failed','dead') AND created_at >= %d), "
        "(SELECT count(*) FROM webhook_deliveries WHERE created_at >= %d), "
        "(SELECT count(*) FROM webhook_subscriptions WHERE active = false AND consecutive_failures > 0)"
        % (cutoff, cutoff, cutoff)
    )
    out = subprocess.run(
        ["docker", "exec", PG_CONTAINER, "psql", "-U", PG_ROLE, "-d", PG_DB, "-tAF,", "-c", sql],
        capture_output=True, text=True, timeout=30,
    )
    if out.returncode != 0:
        raise RuntimeError("psql failed: %s" % (out.stderr.strip()[:200]))
    parts = out.stdout.strip().split(",")
    if len(parts) != 4:
        raise RuntimeError("unexpected psql output: %r" % out.stdout.strip())
    dead, failed, total, disabled = (int(p) for p in parts)

    # Test seams.
    dead = _int_env("WEBHOOK_CANARY_FORCE_DEAD", dead) if "WEBHOOK_CANARY_FORCE_DEAD" in os.environ else dead
    failed = _int_env("WEBHOOK_CANARY_FORCE_FAILED", failed) if "WEBHOOK_CANARY_FORCE_FAILED" in os.environ else failed
    total = _int_env("WEBHOOK_CANARY_FORCE_TOTAL", total) if "WEBHOOK_CANARY_FORCE_TOTAL" in os.environ else total
    disabled = _int_env("WEBHOOK_CANARY_FORCE_DISABLED", disabled) if "WEBHOOK_CANARY_FORCE_DISABLED" in os.environ else disabled
    return dead, failed, total, disabled


def classify(dead, failed, total, disabled):
    """Return (breached: bool, cls: str|None, condition: str|None) — highest-priority breach."""
    rate = (failed / total) if total > 0 else 0.0
    if disabled >= DISABLED_THRESHOLD:
        return True, "AUTO-DISABLED", "%d subscription(s) auto-disabled (>= %d)" % (disabled, DISABLED_THRESHOLD)
    if dead >= DEAD_THRESHOLD:
        return True, "DEAD-SPIKE", "%d dead deliveries in %dh (>= %d)" % (dead, WINDOW_HOURS, DEAD_THRESHOLD)
    if total >= MIN_VOLUME and rate >= FAILED_RATE_THRESHOLD:
        return True, "FAILED-RATE", "failed-rate %.0f%% over %d deliveries in %dh (>= %.0f%%, min vol %d)" % (
            rate * 100, total, WINDOW_HOURS, FAILED_RATE_THRESHOLD * 100, MIN_VOLUME)
    return False, None, None


def build_body(cls, condition, consecutive, dead, failed, total, disabled):
    return "\n".join([
        "\U0001F6D1 %s" % ALERT_ID,
        condition,
        "Sustained %d/%d consecutive cycles | window=%dh | dead=%d failed=%d total=%d disabled=%d"
        % (consecutive, SUSTAINED_CYCLES, WINDOW_HOURS, dead, failed, total, disabled),
        "Action: dispatch OPS-WEBHOOK-DELIVERY-%s-W{NEXT} via Cowork → Claude Code" % cls,
        "Audit shape: %s" % AUDIT_DOC,
        "Source log: %s" % LOG,
    ])


def fire(body):
    """Hand the body to the wrapper (it owns severity/cooldown/DRY_RUN/fail-open)."""
    proc = subprocess.run([WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"], input=body, capture_output=True, text=True, timeout=30)
    log("wrapper exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))
    if os.environ.get("DRY_RUN_TG") == "1":
        log("WOULD_FIRE: class=%s (DRY_RUN_TG=1, no POST)" % ALERT_ID)


def main():
    try:
        dead, failed, total, disabled = query_metrics()
        breached, cls, condition = classify(dead, failed, total, disabled)
        if not breached:
            write_breach_count(0)
            log("HEALTHY: dead=%d failed=%d total=%d disabled=%d (counter reset)" % (dead, failed, total, disabled))
            return 0
        consecutive = read_breach_count() + 1
        write_breach_count(consecutive)
        if consecutive < SUSTAINED_CYCLES:
            log("ACCUMULATING: class=%s %s | %d/%d cycles (not yet sustained — silent)" % (cls, condition, consecutive, SUSTAINED_CYCLES))
            return 0
        log("SUSTAINED: class=%s %s | %d/%d cycles → firing wrapper" % (cls, condition, consecutive, SUSTAINED_CYCLES))
        fire(build_body(cls, condition, consecutive, dead, failed, total, disabled))
        return 0
    except Exception as e:  # noqa: BLE001 — fail-open is the contract
        log("FAIL_OPEN: %s: %s" % (type(e).__name__, e))
        return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 C5 — webhook delivery-health canary.

Host-side (Hetzner /opt/algovault-monitoring/) drift detector for the outbound
webhook delivery service. Reads `webhook_subscriptions` + `webhook_deliveries`
(read-only via `docker exec ... psql -U algovault_autopilot`) and fires an
operator-action-required Telegram alert ONLY on a NEW *terminal* death — never on
a transient outage the health-probe sweep is already recovering. 6th consumer of
`send_telegram.sh`; it does NOT re-implement the severity/cooldown/DRY_RUN/fail-open
gates (the wrapper owns those).

Post-lifecycle semantics (this wave): a subscription's SoT is `delivery_state`
(active|degraded|quarantined|disabled). `quarantined`/`degraded` are SELF-HEALING
(the C4 sweep probes + auto-resumes) → NEVER page. Only `delivery_state='disabled'`
is terminal (re-registration required: `permanent_http_410` or 7d `quarantine_expired`).

Classes (priority): TERMINAL-DISABLE (a sub reached delivery_state='disabled') >
DEAD-SPIKE > FAILED-RATE. The latter two are LIFECYCLE-AWARE — they count only
deliveries to subs still in active/degraded (quarantined/disabled subs are excluded
because the lifecycle is already handling them), so a transient burst the sweep is
recovering does not page.

Dedup + auto-resolve: the fired disabled-set is persisted in .alert-state/. A page
fires ONCE per NEW disabled sub (still gated by the SUSTAINED_CYCLES sustain +
wrapper cooldown); when a sub leaves the disabled set (re-registered / deleted) the
canary auto-resolves SILENTLY (recovery alerts are noise). Retires the pre-wave
alarm-fatigue where the raw active=false count re-fired every cycle.

Alert contract: severity=CRITICAL_PERSISTENT only; 24h cooldown per alert_id
(wrapper); fail-open (exit 0 on ALL errors); DRY_RUN_TG=1 routes through every gate
but skips the POST. recommended_wave uses the OPS-WEBHOOK-DELIVERY-<CLASS>-W{NEXT}
template (NO literal Wn — the wrapper's send-time resolver fills {NEXT}).

Test seams (env): WEBHOOK_CANARY_FORCE_DISABLED_IDS (comma ids) +
WEBHOOK_CANARY_FORCE_{DEAD,FAILED,TOTAL} override the measured metrics;
WEBHOOK_CANARY_SUSTAINED_CYCLES / _WINDOW_HOURS / thresholds override config.
`--self-test` runs the hermetic fire/silent/resolve scenario suite (DRY_RUN, temp
state, no DB, no wrapper).
"""
import argparse
import os
import subprocess
import sys
import tempfile
import time

ALERT_ID = "WEBHOOK_DELIVERY_DRIFT"
WRAPPER = "/opt/algovault-monitoring/send_telegram.sh"
STATE_DIR = "/opt/algovault-monitoring/.alert-state"
BREACH_COUNT_FILE = os.path.join(STATE_DIR, "webhook-delivery-canary-breach.count")
DISABLED_SET_FILE = os.path.join(STATE_DIR, "webhook-delivery-canary-disabled.set")
LOG = "/var/log/algovault-webhook-delivery-canary.log"
PG_CONTAINER = "crypto-quant-signal-mcp-postgres-1"
PG_ROLE = "algovault_autopilot"
PG_DB = "signal_performance"
AUDIT_DOC = "audits/OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1-endpoint-truth.md"


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


def load_disabled_set():
    try:
        with open(DISABLED_SET_FILE) as fh:
            return set(int(x) for x in fh.read().split() if x.strip())
    except (OSError, ValueError):
        return set()


def save_disabled_set(ids):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(DISABLED_SET_FILE, "w") as fh:
            fh.write(" ".join(str(i) for i in sorted(ids)))
    except OSError as e:
        log("WARN: could not persist disabled set: %s" % e)


def _psql(sql, fieldsep=None):
    args = ["docker", "exec", PG_CONTAINER, "psql", "-U", PG_ROLE, "-d", PG_DB, "-tA"]
    if fieldsep:
        args += ["-F", fieldsep]
    args += ["-c", sql]
    out = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError("psql failed: %s" % out.stderr.strip()[:200])
    return out.stdout


def query_state():
    """Return (disabled_ids:set, dead, failed, total). Test seams override the DB."""
    forced_ids = os.environ.get("WEBHOOK_CANARY_FORCE_DISABLED_IDS")
    if forced_ids is not None:
        disabled_ids = set(int(x) for x in forced_ids.split(",") if x.strip())
    else:
        raw = _psql("SELECT id FROM webhook_subscriptions WHERE delivery_state = 'disabled' ORDER BY id")
        disabled_ids = set(int(x) for x in raw.split() if x.strip())

    forced_metrics = all(("WEBHOOK_CANARY_FORCE_" + k) in os.environ for k in ("DEAD", "FAILED", "TOTAL"))
    if forced_metrics:
        dead = _int_env("WEBHOOK_CANARY_FORCE_DEAD", 0)
        failed = _int_env("WEBHOOK_CANARY_FORCE_FAILED", 0)
        total = _int_env("WEBHOOK_CANARY_FORCE_TOTAL", 0)
    else:
        cutoff = int(time.time()) - WINDOW_HOURS * 3600
        # LIFECYCLE-AWARE: only deliveries to subs still active/degraded (quarantined/
        # disabled subs are already being handled by the sweep → excluded so a
        # recovering transient burst does not page).
        sql = (
            "SELECT count(*) FILTER (WHERE d.status = 'dead'), "
            "count(*) FILTER (WHERE d.status IN ('failed','dead')), count(*) "
            "FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id "
            "WHERE d.created_at >= %d AND s.delivery_state IN ('active','degraded')" % cutoff
        )
        parts = _psql(sql, fieldsep=",").strip().split(",")
        if len(parts) != 3:
            raise RuntimeError("unexpected metrics output: %r" % parts)
        dead, failed, total = (int(p) for p in parts)
    return disabled_ids, dead, failed, total


def classify_secondary(dead, failed, total):
    """DEAD-SPIKE / FAILED-RATE over the LIFECYCLE-AWARE (active/degraded-only) counts."""
    rate = (failed / total) if total > 0 else 0.0
    if dead >= DEAD_THRESHOLD:
        return True, "DEAD-SPIKE", "%d dead deliveries to active subs in %dh (>= %d)" % (dead, WINDOW_HOURS, DEAD_THRESHOLD)
    if total >= MIN_VOLUME and rate >= FAILED_RATE_THRESHOLD:
        return True, "FAILED-RATE", "failed-rate %.0f%% over %d active-sub deliveries in %dh (>= %.0f%%, min vol %d)" % (
            rate * 100, total, WINDOW_HOURS, FAILED_RATE_THRESHOLD * 100, MIN_VOLUME)
    return False, None, None


def build_body(cls, condition, consecutive, dead, failed, total, disabled):
    return "\n".join([
        "\U0001F6D1 %s" % ALERT_ID,
        condition,
        "Sustained %d/%d consecutive cycles | window=%dh | disabled=%d dead=%d failed=%d total=%d"
        % (consecutive, SUSTAINED_CYCLES, WINDOW_HOURS, disabled, dead, failed, total),
        "Action: dispatch OPS-WEBHOOK-DELIVERY-%s-W{NEXT} via Cowork → Claude Code" % cls,
        "Audit shape: %s" % AUDIT_DOC,
        "Source log: %s" % LOG,
    ])


def fire(body):
    """Hand the body to the wrapper (it owns severity/cooldown/DRY_RUN/fail-open).
    In --self-test we skip the wrapper entirely (hermetic)."""
    if os.environ.get("WEBHOOK_CANARY_SELFTEST") == "1":
        log("WOULD_FIRE: (self-test — wrapper skipped)")
        return
    proc = subprocess.run([WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"], input=body, capture_output=True, text=True, timeout=30)
    log("wrapper exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))
    if os.environ.get("DRY_RUN_TG") == "1":
        log("WOULD_FIRE: class=%s (DRY_RUN_TG=1, no POST)" % ALERT_ID)


def run_cycle(disabled_ids, dead, failed, total):
    """One evaluation. Handles auto-resolve, dedup, sustain + fire. Returns an action dict."""
    disabled_ids = set(disabled_ids)
    alerted = load_disabled_set()

    # 1) Auto-resolve (SILENT): subs that left the disabled set (re-registered / deleted).
    resolved = alerted - disabled_ids
    if resolved:
        log("RESOLVED: subscription(s) %s no longer disabled (auto-resolve, silent)" % ",".join(map(str, sorted(resolved))))
        alerted = alerted - resolved
        save_disabled_set(alerted)

    # 2) Breach detection — a NEW terminal-disable (per-sub dedup) beats the rate classes.
    new_ids = disabled_ids - alerted
    if new_ids:
        cls = "TERMINAL-DISABLE"
        condition = "%d subscription(s) permanently disabled (new: %s)" % (len(disabled_ids), ",".join(map(str, sorted(new_ids))))
    else:
        breached, cls, condition = classify_secondary(dead, failed, total)
        if not breached:
            write_breach_count(0)
            log("HEALTHY: disabled=%d dead=%d failed=%d total=%d (counter reset)" % (len(disabled_ids), dead, failed, total))
            return {"action": "silent"}

    # 3) Sustain gate → fire once.
    consecutive = read_breach_count() + 1
    write_breach_count(consecutive)
    if consecutive < SUSTAINED_CYCLES:
        log("ACCUMULATING: class=%s %s | %d/%d cycles (not yet sustained — silent)" % (cls, condition, consecutive, SUSTAINED_CYCLES))
        return {"action": "accumulate", "class": cls}
    log("SUSTAINED: class=%s %s | %d/%d cycles → firing wrapper" % (cls, condition, consecutive, SUSTAINED_CYCLES))
    fire(build_body(cls, condition, consecutive, dead, failed, total, len(disabled_ids)))
    write_breach_count(0)
    if new_ids:
        # Remember the now-alerted disabled set so it does NOT re-fire every cycle.
        save_disabled_set(alerted | disabled_ids)
    return {"action": "fire", "class": cls}


def main():
    try:
        disabled_ids, dead, failed, total = query_state()
        run_cycle(disabled_ids, dead, failed, total)
        return 0
    except Exception as e:  # noqa: BLE001 — fail-open is the contract
        log("FAIL_OPEN: %s: %s" % (type(e).__name__, e))
        return 0


def self_test():
    """Hermetic fire/silent/resolve scenarios — no DB, no wrapper, temp state."""
    global STATE_DIR, BREACH_COUNT_FILE, DISABLED_SET_FILE, LOG
    tmp = tempfile.mkdtemp(prefix="webhook-canary-selftest-")
    STATE_DIR = tmp
    BREACH_COUNT_FILE = os.path.join(tmp, "breach.count")
    DISABLED_SET_FILE = os.path.join(tmp, "disabled.set")
    LOG = os.path.join(tmp, "selftest.log")
    os.environ["WEBHOOK_CANARY_SELFTEST"] = "1"
    os.environ["DRY_RUN_TG"] = "1"

    failures = []

    def check(name, cond):
        print("  [%s] %s" % ("PASS" if cond else "FAIL", name))
        if not cond:
            failures.append(name)

    # A) all healthy → silent
    check("all-healthy → silent", run_cycle(set(), 0, 0, 0)["action"] == "silent")

    # B) a NEW disabled sub accumulates then fires ONCE
    for i in range(SUSTAINED_CYCLES - 1):
        check("new disabled sub cycle %d → accumulate" % (i + 1), run_cycle({6}, 0, 0, 0)["action"] == "accumulate")
    r = run_cycle({6}, 0, 0, 0)
    check("new disabled sub sustained → fire TERMINAL-DISABLE once", r["action"] == "fire" and r["class"] == "TERMINAL-DISABLE")

    # C) same disabled sub persists → NO re-fire (dedup)
    check("same disabled sub persists → silent (no re-fire)", run_cycle({6}, 0, 0, 0)["action"] == "silent")

    # D) disabled set clears (re-registered / self-heal) → auto-resolve, silent, state emptied
    check("disabled set clears → silent (auto-resolve)", run_cycle(set(), 0, 0, 0)["action"] == "silent")
    check("alerted set emptied after resolve", load_disabled_set() == set())

    # E) a transient burst the sweep is recovering (excluded from counts) → silent
    check("recovering transient burst (excluded counts) → silent", run_cycle(set(), 0, 0, 0)["action"] == "silent")

    # F) a genuine systemic DEAD-SPIKE among ACTIVE subs still pages (sustained)
    write_breach_count(SUSTAINED_CYCLES - 1)
    r = run_cycle(set(), DEAD_THRESHOLD, DEAD_THRESHOLD, DEAD_THRESHOLD + 5)
    check("systemic dead-spike (active subs) sustained → fire DEAD-SPIKE", r["action"] == "fire" and r["class"] == "DEAD-SPIKE")

    ok = not failures
    print("SELF-TEST: %s (%d failed)" % ("PASS" if ok else "FAIL", len(failures)))
    try:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
    except Exception:
        pass
    return 0 if ok else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="webhook delivery-health canary")
    parser.add_argument("--self-test", action="store_true", help="run the hermetic scenario suite and exit")
    a = parser.parse_args()
    if a.self_test:
        sys.exit(self_test())
    sys.exit(main())

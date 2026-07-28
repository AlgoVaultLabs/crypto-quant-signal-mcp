#!/usr/bin/env python3
"""
monitoring-inventory-reconcile.py — OPS-MONITORING-INVENTORY-PARITY-W1 (2026-07-28)

Bidirectional reconciler between `ops/monitoring/monitoring-inventory.json` (the committed SoT)
and what is ACTUALLY installed on the host.

## Why this exists

Before this wave there was no authoritative answer to "what monitoring is actually running".
A host artifact existed because some wave once copied it there; a cron line existed because some
wave once added it. Neither had a declared owner, so the set could only be reconstructed by
archaeology — and the prose reconstruction went stale by the next wave. The R1 probe found:

  * 18 host artifacts with NO repo ancestor, 6 of them on live crons — six alarms whose source
    could not be reviewed or reverted.
  * `send_telegram.sh` — the shared alert wrapper CLAUDE.md forbids consumers from
    re-implementing — unversioned on BOTH hosts, with the two copies already BEHAVIORALLY
    diverged, and it changed again mid-wave with no recoverable prior revision.
  * 2 committed canaries (`nav-drift`, `analytics-drift`) sitting DARK while system-map.md
    listed them as consumers.

`OPS-FRESHNESS-SOURCE-TRUTH-W1` established that a WRONG alarm is worse than no alarm. An
alerting layer whose COVERAGE is unknown is that defect one level up: you cannot tell whether
silence means healthy or means the guard was never installed.

## The five checks (both directions)

  HASH_DRIFT      repo -> host   an `installed` row whose host file sha256 != the repo copy
  ORPHAN          host -> repo   an artifact under /opt/algovault-monitoring/ absent from the inventory
  DARK            inventory -> crontab   an `installed` row with a `schedule` and no live cron line
  SCHEDULE_DRIFT  crontab -> inventory   the live cron spec != the row's `schedule`
  PENDING_STALE   inventory      a `pending` / `unclassified` row older than 30d

## Deliberately NOT self-healing

Detect -> Alert -> Escalate, with no Recover step. Auto-installing a missing cron or auto-copying
a drifted file would be an unreviewed privileged mutation performed by an unattended daily job.
That principle governs THIS process; it does not govern a human-dispatched, reviewed install.

## Modes

  (no flag)     evaluate, log every check, alert on breach via send_telegram.sh
  --check       evaluate silently, exit non-zero on any drift (CI / gate use)
  --self-test   hermetic scenario suite; no host access, no wrapper, no state writes

Reads the host locally when running ON the host; falls back to SSH otherwise, so the same file
serves the 06:57 cron and a laptop-side gate run. Fail-open on any SSH/parse failure.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone, date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
INVENTORY_PATH = Path(os.environ.get("MONITORING_INVENTORY_PATH", REPO_ROOT / "ops/monitoring/monitoring-inventory.json"))
MONITORING_DIR = os.environ.get("MONITORING_DIR", "/opt/algovault-monitoring")
SSH_TARGET = os.environ.get("MONITORING_SSH_TARGET", "root@204.168.185.24")
SSH_KEY = os.environ.get("MONITORING_SSH_KEY", str(Path.home() / ".ssh/algovault_deploy"))
WRAPPER = os.environ.get("TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
STATE_DIR = Path(os.environ.get("MONITORING_STATE_DIR", "/opt/algovault-monitoring/.alert-state"))

ALERT_ID = "MONITORING_INVENTORY_DRIFT"
RECOMMENDED_WAVE = "OPS-MONITORING-INVENTORY-RESTORE-W{NEXT}"
AUDIT_DOC_REF = "audits/OPS-MONITORING-INVENTORY-PARITY-W1-endpoint-truth.md"
CONSECUTIVE_TO_PAGE = 3
PENDING_STALE_DAYS = 30

# ORPHAN scan exclusions. Runtime state, caches, operator backups and — critically —
# `autopilot-pg-creds` (mode 600), which must never be proposed for commit.
ORPHAN_EXCLUDE_RE = re.compile(
    r"(^\.|/\.)"                       # dotfiles/dotdirs (.alert-state, .drift-canary-state, …)
    r"|(^|/)backups?(/|$)"
    r"|\.bak($|[.\-])|\.disabled[.\-]"
    r"|(^|/)autopilot-pg-creds$"
    r"|(^|/)__pycache__(/|$)"
)
ARTIFACT_SUFFIXES = (".py", ".sh", ".mjs", ".yaml", ".json")


def log(msg):
    print(f"[{datetime.now(timezone.utc).isoformat(timespec='seconds')}] {msg}", flush=True)


# ─────────── host access (local when on-host, SSH otherwise; fail-open either way) ───────────

def _on_host():
    return Path(MONITORING_DIR).is_dir() and Path(WRAPPER).exists()


def _run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60)


def host_listing():
    """{basename: sha256} for every artifact directly under MONITORING_DIR. None on failure."""
    if _on_host():
        out = {}
        try:
            for p in Path(MONITORING_DIR).iterdir():
                if p.is_file() and p.suffix in ARTIFACT_SUFFIXES and not ORPHAN_EXCLUDE_RE.search(p.name):
                    out[p.name] = hashlib.sha256(p.read_bytes()).hexdigest()
            return out
        except OSError as exc:
            log(f"HOST_LISTING_FAILED(local): {exc} — fail-open")
            return None
    cmd = ["ssh", "-i", SSH_KEY, "-o", "ConnectTimeout=15", "-o", "BatchMode=yes", SSH_TARGET,
           f"find {MONITORING_DIR} -maxdepth 1 -type f "
           r"\( -name '*.py' -o -name '*.sh' -o -name '*.mjs' -o -name '*.yaml' -o -name '*.json' \) "
           "-exec sha256sum {} \\;"]
    try:
        r = _run(cmd)
        if r.returncode != 0:
            log(f"HOST_LISTING_FAILED(ssh rc={r.returncode}): {r.stderr.strip()[:160]} — fail-open")
            return None
        out = {}
        for line in r.stdout.splitlines():
            parts = line.split(None, 1)
            if len(parts) == 2:
                name = os.path.basename(parts[1].strip())
                if not ORPHAN_EXCLUDE_RE.search(name):
                    out[name] = parts[0]
        return out
    except Exception as exc:
        log(f"HOST_LISTING_FAILED(ssh): {type(exc).__name__}: {exc} — fail-open")
        return None


def host_crontab():
    """Raw crontab text, or None on failure."""
    cmd = ["crontab", "-l"] if _on_host() else \
        ["ssh", "-i", SSH_KEY, "-o", "ConnectTimeout=15", "-o", "BatchMode=yes", SSH_TARGET, "crontab -l"]
    try:
        r = _run(cmd)
        if r.returncode != 0:
            log(f"CRONTAB_READ_FAILED(rc={r.returncode}): {r.stderr.strip()[:160]} — fail-open")
            return None
        return r.stdout
    except Exception as exc:
        log(f"CRONTAB_READ_FAILED: {type(exc).__name__}: {exc} — fail-open")
        return None


# ─────────── pure check logic (fixture-drivable — this is what --self-test exercises) ───────────

def cron_spec_for(crontab_text, host_path):
    """The 5-field spec of the live line invoking host_path, or None.

    Matched by host_path SUBSTRING, never by whole-line equality: live lines carry flock,
    docker exec, interpreter prefixes, env assignments and redirects, so an exact compare
    would report every row as DARK.
    """
    if not crontab_text:
        return None
    for line in crontab_text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if host_path in s:
            f = s.split()
            if len(f) >= 5:
                return " ".join(f[:5])
    return None


def check_hash_drift(rows, host_hashes):
    """repo -> host. Skipped for repo-resident rows: their host_path IS the repo copy, so the
    comparison is vacuous — reporting them as in-sync would be a lie by construction."""
    out = []
    for r in rows:
        if r.get("install_state") != "installed" or r.get("repo_resident"):
            continue
        name = os.path.basename(r["host_path"])
        live = host_hashes.get(name)
        if live is None:
            continue  # absence is DARK/ORPHAN's business, not HASH_DRIFT's
        if r.get("sha256") and live != r["sha256"]:
            severity = "SEVERE" if r.get("kind") == "baseline-data" else "normal"
            out.append({"id": r["id"], "kind": r.get("kind"), "severity": severity,
                        "repo": (r.get("sha256") or "")[:12], "host": live[:12]})
    return out


def check_orphan(rows, host_hashes):
    """host -> repo."""
    known = {os.path.basename(r["host_path"]) for r in rows}
    return sorted(n for n in host_hashes if n not in known)


def check_dark(rows, crontab_text):
    """inventory -> crontab."""
    out = []
    for r in rows:
        if r.get("install_state") != "installed" or not r.get("schedule"):
            continue
        if r.get("invoked_by", "").startswith("systemd:"):
            continue
        if cron_spec_for(crontab_text, r["host_path"]) is None:
            out.append(r["id"])
    return out


def check_schedule_drift(rows, crontab_text):
    """crontab -> inventory."""
    out = []
    for r in rows:
        if r.get("install_state") != "installed" or not r.get("schedule"):
            continue
        live = cron_spec_for(crontab_text, r["host_path"])
        if live is not None and live != r["schedule"]:
            out.append({"id": r["id"], "inventory": r["schedule"], "live": live})
    return out


def check_pending_stale(rows, today=None):
    """inventory. `unclassified` shares the clock — an unowned artifact must not age silently."""
    today = today or date.today()
    out = []
    for r in rows:
        if r.get("install_state") not in ("pending", "unclassified"):
            continue
        since = r.get("pending_since")
        if not since:
            out.append({"id": r["id"], "age_days": None, "state": r["install_state"]})
            continue
        try:
            age = (today - date.fromisoformat(since)).days
        except ValueError:
            continue
        if age > PENDING_STALE_DAYS:
            out.append({"id": r["id"], "age_days": age, "state": r["install_state"]})
    return out


def divergent_copy_findings(rows):
    """Unreconciled cross-host copies. Encoded as an inventory FIELD rather than a prose
    follow-up precisely because prose follow-ups get lost — that is the class this wave retires.
    Reported every run until someone clears the field."""
    out = []
    for r in rows:
        for d in r.get("divergent_copies", []) or []:
            if d.get("state") == "unreconciled":
                out.append({"id": r["id"], "host": d.get("host"),
                            "classification": d.get("classification"), "priority": d.get("priority")})
    return out


# ─────────── alerting (all gates delegated to the wrapper — never re-implemented here) ───────────

def breach_state_path():
    return STATE_DIR / "monitoring-inventory-breach.count"


def update_breach_streak(breached):
    p = breach_state_path()
    if not breached:
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass
        return 0
    prev = 0
    try:
        if p.exists():
            prev = int(p.read_text().strip() or "0")
    except (OSError, ValueError):
        prev = 0
    streak = prev + 1
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(str(streak))
    except OSError as exc:
        log(f"BREACH_STATE_WRITE_FAILED: {exc}")
    return streak


def build_body(findings, streak):
    lines = [f"🛑 {ALERT_ID}",
             "Condition: the committed monitoring inventory no longer matches the host "
             f"({CONSECUTIVE_TO_PAGE} consecutive breaches)"]
    for k, v in findings.items():
        if v:
            lines.append(f"  {k}: {v if not isinstance(v, list) else ', '.join(str(x) for x in v)[:220]}")
    lines += [f"State: breach streak {streak}",
              f"Action: dispatch {RECOMMENDED_WAVE} via Cowork → Claude Code",
              f"Audit shape: {AUDIT_DOC_REF}",
              "Source log: /var/log/monitoring-inventory-reconcile.log"]
    return "\n".join(lines)


def call_wrapper(body):
    try:
        subprocess.run([WRAPPER, ALERT_ID, "CRITICAL_PERSISTENT", "-"],
                       input=body, text=True, timeout=20, check=False)
    except Exception as exc:
        log(f"FAILED_WRAPPER_CALL: {exc}")


# ─────────── main ───────────

def evaluate(rows, host_hashes, crontab_text):
    return {
        "HASH_DRIFT": check_hash_drift(rows, host_hashes),
        "ORPHAN": check_orphan(rows, host_hashes),
        "DARK": check_dark(rows, crontab_text),
        "SCHEDULE_DRIFT": check_schedule_drift(rows, crontab_text),
        "PENDING_STALE": check_pending_stale(rows),
        "DIVERGENT_COPY": divergent_copy_findings(rows),
    }


def main(check_mode=False):
    try:
        doc = json.loads(INVENTORY_PATH.read_text())
        rows = doc["artifacts"]
    except Exception as exc:
        log(f"INVENTORY_LOAD_FAILED: {exc} — exit 0 (fail-open)")
        return 0
    if not check_mode:
        log(f"START monitoring-inventory-reconcile rows={len(rows)} inventory={INVENTORY_PATH}")

    host_hashes = host_listing()
    crontab_text = host_crontab()
    if host_hashes is None or crontab_text is None:
        log("HOST_UNREACHABLE — cannot reconcile; exit 0 (fail-open, the reconciler must never "
            "be the thing that breaks the box)")
        return 0

    f = evaluate(rows, host_hashes, crontab_text)
    # DIVERGENT_COPY is a standing report, not a drift breach — it cannot self-resolve here.
    drift_keys = ("HASH_DRIFT", "ORPHAN", "DARK", "SCHEDULE_DRIFT", "PENDING_STALE")
    drifted = any(f[k] for k in drift_keys)

    if not check_mode:
        # POSITIVE per-check output — never absence-of-alert. A check silently skipped by a load
        # error must not read identically to a check that passed.
        for k in drift_keys + ("DIVERGENT_COPY",):
            v = f[k]
            log(f"CHECK {k}: {'BREACH ' + json.dumps(v) if v else 'OK (empty set)'}")
        streak = update_breach_streak(drifted)
        log(f"BREACH_STREAK {streak}/{CONSECUTIVE_TO_PAGE}")
        if drifted and streak >= CONSECUTIVE_TO_PAGE:
            call_wrapper(build_body(f, streak))
            log(f"ALERT_SENT {ALERT_ID}")
        elif drifted:
            log(f"SUSTAIN_PENDING: breach {streak}/{CONSECUTIVE_TO_PAGE} — not paging yet")
        log(f"END reconcile drifted={drifted} rows={len(rows)}")
    return 1 if (check_mode and drifted) else 0


def self_test():
    failures, checks = [], 0

    def ck(name, got, want):
        nonlocal checks
        checks += 1
        if got != want:
            failures.append(f"{name}: got {got!r} want {want!r}")

    CRON = (
        "# comment\n"
        "57 0 * * * /opt/algovault-monitoring/website-drift-canary.py >> /var/log/x.log 2>&1\n"
        "13,28,43,58 * * * * /usr/bin/python3 /opt/algovault-monitoring/webhook-delivery-canary.py >/dev/null\n"
        "37 * * * * bash /opt/crypto-quant-signal-mcp/ops/cron/seed-coverage-canary.sh >/dev/null\n"
    )
    row = lambda **kw: {"id": "r", "host_path": "/opt/algovault-monitoring/a.py", "sha256": "a" * 64,
                        "install_state": "installed", "kind": "executable", "invoked_by": "crontab:root", **kw}

    # ── crontab matching must be SUBSTRING, not line equality (live lines carry prefixes) ──
    ck("spec found through a flock/docker prefix",
       cron_spec_for(CRON, "/opt/algovault-monitoring/webhook-delivery-canary.py"), "13,28,43,58 * * * *")
    ck("spec found for a repo-resident path",
       cron_spec_for(CRON, "/opt/crypto-quant-signal-mcp/ops/cron/seed-coverage-canary.sh"), "37 * * * *")
    ck("absent path -> None", cron_spec_for(CRON, "/opt/algovault-monitoring/nope.sh"), None)
    ck("comment line is not matched", cron_spec_for("# 1 2 3 4 5 /opt/x.py\n", "/opt/x.py"), None)

    # ── 1. HASH_DRIFT, both directions ──
    ck("hash match -> clean", check_hash_drift([row()], {"a.py": "a" * 64}), [])
    d = check_hash_drift([row()], {"a.py": "b" * 64})
    ck("hash mismatch -> breach", len(d), 1)
    ck("executable drift severity normal", d[0]["severity"], "normal")
    ck("baseline-data drift severity SEVERE",
       check_hash_drift([row(kind="baseline-data")], {"a.py": "b" * 64})[0]["severity"], "SEVERE")
    ck("repo-resident rows are SKIPPED, not compared",
       check_hash_drift([row(repo_resident=True)], {"a.py": "b" * 64}), [])
    ck("retired rows are not hash-checked",
       check_hash_drift([row(install_state="retired")], {"a.py": "b" * 64}), [])

    # ── 2. ORPHAN, both directions ──
    ck("known file -> no orphan", check_orphan([row()], {"a.py": "x"}), [])
    ck("unknown file -> orphan", check_orphan([row()], {"a.py": "x", "rogue.py": "y"}), ["rogue.py"])
    for junk in (".drift-canary-state", "send_telegram.sh.bak", "x.sh.disabled-retire-2026",
                 "autopilot-pg-creds", "__pycache__"):
        ck(f"excluded from orphan scan: {junk}", bool(ORPHAN_EXCLUDE_RE.search(junk)), True)
    ck("a real artifact is NOT excluded", bool(ORPHAN_EXCLUDE_RE.search("website-drift-canary.py")), False)

    # ── 3. DARK, both directions — the two cases this wave found ──
    ck("scheduled + live cron line -> not dark",
       check_dark([row(host_path="/opt/algovault-monitoring/website-drift-canary.py",
                       schedule="57 0 * * *")], CRON), [])
    ck("nav-drift fixture: committed, scheduled, NO cron line -> DARK",
       check_dark([row(id="nav-drift-canary", host_path="/opt/algovault-monitoring/nav-drift-canary.sh",
                       schedule="17 7 * * 2")], CRON), ["nav-drift-canary"])
    ck("analytics-drift fixture: DARK",
       check_dark([row(id="analytics-drift-canary",
                       host_path="/opt/algovault-monitoring/analytics-drift-canary.sh",
                       schedule="33 9 * * 4")], CRON), ["analytics-drift-canary"])
    ck("schedule:null row is never dark",
       check_dark([row(schedule=None)], CRON), [])
    ck("systemd-invoked row is never dark (no cron line by design)",
       check_dark([row(host_path="/opt/algovault-monitoring/funnel-leak-detector.py",
                       schedule="0 1 * * *", invoked_by="systemd:x.timer")], CRON), [])

    # ── 4. SCHEDULE_DRIFT, both directions ──
    ck("matching spec -> clean",
       check_schedule_drift([row(host_path="/opt/algovault-monitoring/website-drift-canary.py",
                                 schedule="57 0 * * *")], CRON), [])
    sd = check_schedule_drift([row(host_path="/opt/algovault-monitoring/website-drift-canary.py",
                                   schedule="39 0 * * *")], CRON)
    ck("moved cron -> SCHEDULE_DRIFT", len(sd), 1)
    ck("drift names both specs", (sd[0]["inventory"], sd[0]["live"]), ("39 0 * * *", "57 0 * * *"))

    # ── 5. PENDING_STALE, both directions ──
    T = date(2026, 9, 1)
    ck("fresh pending -> clean",
       check_pending_stale([row(install_state="pending", pending_since="2026-08-20")], T), [])
    ck("stale pending -> breach",
       len(check_pending_stale([row(install_state="pending", pending_since="2026-07-01")], T)), 1)
    ck("unclassified shares the clock",
       len(check_pending_stale([row(install_state="unclassified", pending_since="2026-07-01")], T)), 1)
    ck("installed rows are never pending-stale",
       check_pending_stale([row(pending_since="2020-01-01")], T), [])

    # ── divergent copies are reported until explicitly cleared ──
    ck("unreconciled divergent copy is reported",
       len(divergent_copy_findings([row(divergent_copies=[{"host": "178", "state": "unreconciled"}])])), 1)
    ck("reconciled divergent copy is silent",
       divergent_copy_findings([row(divergent_copies=[{"host": "178", "state": "reconciled"}])]), [])

    # ── the reconciler is row 1 of its own inventory ──
    try:
        doc = json.loads(INVENTORY_PATH.read_text())
        ids = [r["id"] for r in doc["artifacts"]]
        ck("reconciler is registered in its own inventory", "monitoring-inventory-reconcile" in ids, True)
        ck("inventory is registered too", "monitoring-inventory" in ids, True)
    except Exception as exc:
        failures.append(f"inventory self-registration: {exc}")

    for f_ in failures:
        log(f"SELF_TEST_FAIL: {f_}")
    log(f"SELF_TEST {'PASS' if not failures else 'FAIL'} checks={checks} failures={len(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="monitoring inventory reconciler")
    ap.add_argument("--check", action="store_true", help="silent; exit non-zero on any drift")
    ap.add_argument("--self-test", action="store_true", help="hermetic scenario suite; exit non-zero on failure")
    a = ap.parse_args()
    if a.self_test:
        sys.exit(self_test())
    sys.exit(main(check_mode=a.check))

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
  REGISTRY_PARITY registry -> host   an `installed_at` entry on THIS host whose live file != the
                                     row's ONE canonical sha256
  NO_BACKUP       host -> host   a `load-bearing` row installed here with zero `*.bak*` beside it

plus DIVERGENT_COPY, a standing report that cannot self-resolve from a single host.

## Multi-host (OPS-AOE-MONITORING-PARITY-W1, 2026-07-29)

One file, installed on every host, each instance evaluating only the rows it OWNS — declared by
`MONITORING_HOST_LABELS`. Labels (`signal-1`, `aoe-1`) are opaque; label -> address resolution
lives in ssh config / host env and never in the committed JSON, which is public.

`REGISTRY_PARITY` is the generator-level fix. `send_telegram.sh` on the AOE host was NOT a fork —
it was byte-identical to the signal host's own PRE-TEST-CONTEXT-GATE backup, i.e. a pure
unmodified ANCESTOR. Two waves updated the primitive at ONE call site because nothing recorded
that a second host was also a consumer. Detecting divergence afterwards is strictly weaker than
enumerating consumers: detection only tells you the miss already happened. `installed_at` is that
enumeration, and this check asserts every entry against the single canonical hash.

`NO_BACKUP` converts a convention into an assertion. The `.bak.<REASON>` convention existed on
the signal host and worked — it recovered the very revision a prior wave recorded as
"permanently unrecoverable". A convention only one host follows is how that premise went wrong.

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
import errno
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
from datetime import datetime, timezone, date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _resolve_inventory_path():
    """Explicit env → the file SITTING BESIDE this script → the repo layout.

    The sibling rule is the one that works in BOTH layouts, because the inventory is installed
    next to the reconciler on a host (`/opt/algovault-monitoring/`) exactly as it sits next to it
    in the repo (`ops/monitoring/`).

    OPS-AOE-MONITORING-PARITY-W1: the original derived REPO_ROOT from __file__'s grandparent,
    which is correct in a checkout and resolves to `/ops/monitoring/...` on a host. The very first
    unattended run (2026-07-29T06:57:01Z) logged INVENTORY_LOAD_FAILED and exited 0, so the cron
    looked healthy while reconciling NOTHING. `--self-test` could not see it (hermetic, reads the
    repo copy) and neither could a laptop-side `--check` (correct REPO_ROOT). Only running the
    thing where it actually lives exposes this class.
    """
    env = os.environ.get("MONITORING_INVENTORY_PATH")
    if env:
        return Path(env)
    sibling = Path(__file__).resolve().parent / "monitoring-inventory.json"
    if sibling.exists():
        return sibling
    return REPO_ROOT / "ops/monitoring/monitoring-inventory.json"


INVENTORY_PATH = _resolve_inventory_path()
MONITORING_DIR = os.environ.get("MONITORING_DIR", "/opt/algovault-monitoring")
SSH_TARGET = os.environ.get("MONITORING_SSH_TARGET", "root@204.168.185.24")
SSH_KEY = os.environ.get("MONITORING_SSH_KEY", str(Path.home() / ".ssh/algovault_deploy"))
WRAPPER = os.environ.get("TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
STATE_DIR = Path(os.environ.get("MONITORING_STATE_DIR", "/opt/algovault-monitoring/.alert-state"))

# Opaque labels this instance OWNS. The signal host's default includes its pre-label literal
# address so the 36 rows predating OPS-AOE-MONITORING-PARITY-W1 keep matching with no retro-edit
# and no crontab change. The AOE host's cron sets MONITORING_HOST_LABELS=aoe-1.
HOST_LABELS = {s.strip() for s in os.environ.get(
    "MONITORING_HOST_LABELS", "signal-1,204.168.185.24").split(",") if s.strip()}

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


def host_backups():
    """Set of `*.bak*` basenames directly under MONITORING_DIR. None on failure (fail-open).

    Deliberately a SEPARATE listing from host_listing(): the orphan scan excludes backups by
    design, and NO_BACKUP needs exactly what that scan throws away.
    """
    if _on_host():
        try:
            return {p.name for p in Path(MONITORING_DIR).iterdir() if p.is_file() and ".bak" in p.name}
        except OSError as exc:
            log(f"HOST_BACKUPS_FAILED(local): {exc} — fail-open")
            return None
    cmd = ["ssh", "-i", SSH_KEY, "-o", "ConnectTimeout=15", "-o", "BatchMode=yes", SSH_TARGET,
           f"find {MONITORING_DIR} -maxdepth 1 -type f -name '*.bak*' -printf '%f\\n'"]
    try:
        r = _run(cmd)
        if r.returncode != 0:
            log(f"HOST_BACKUPS_FAILED(ssh rc={r.returncode}): {r.stderr.strip()[:160]} — fail-open")
            return None
        return {ln.strip() for ln in r.stdout.splitlines() if ln.strip()}
    except Exception as exc:
        log(f"HOST_BACKUPS_FAILED: {type(exc).__name__}: {exc} — fail-open")
        return None


# ─────────── host ownership (multi-host: evaluate only what THIS instance owns) ───────────

def entries_for_host(row, labels):
    """`installed_at` entries this instance owns. Falls back to the row's own host/host_path for
    rows that predate the registry, so a legacy row is never silently unowned."""
    reg = row.get("installed_at")
    if reg:
        return [e for e in reg if e.get("host") in labels]
    if row.get("host") in labels:
        return [{"host": row.get("host"), "path": row.get("host_path"),
                 "schedule": row.get("schedule")}]
    return []


def owns_row(row, labels):
    return bool(entries_for_host(row, labels))


def schedule_for(row, labels):
    """Per-host schedule wins over the row's — the same artifact runs at different times on
    different hosts (57 6 on signal-1, 17 7 on aoe-1)."""
    for e in entries_for_host(row, labels):
        if "schedule" in e:
            return e["schedule"]
    return row.get("schedule")


def host_path_for(row, labels):
    for e in entries_for_host(row, labels):
        if e.get("path"):
            return e["path"]
    return row.get("host_path")


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


def check_dark(rows, crontab_text, labels=None):
    """inventory -> crontab. Host-scoped: a row scheduled on another host is not dark here."""
    labels = labels if labels is not None else HOST_LABELS
    out = []
    for r in rows:
        sched = schedule_for(r, labels)
        if r.get("install_state") != "installed" or not sched:
            continue
        if r.get("invoked_by", "").startswith("systemd:"):
            continue
        if cron_spec_for(crontab_text, host_path_for(r, labels)) is None:
            out.append(r["id"])
    return out


def check_schedule_drift(rows, crontab_text, labels=None):
    """crontab -> inventory. Compares against THIS host's schedule, not the row's default."""
    labels = labels if labels is not None else HOST_LABELS
    out = []
    for r in rows:
        sched = schedule_for(r, labels)
        if r.get("install_state") != "installed" or not sched:
            continue
        live = cron_spec_for(crontab_text, host_path_for(r, labels))
        if live is not None and live != sched:
            out.append({"id": r["id"], "inventory": sched, "live": live})
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


def check_registry_parity(rows, host_hashes, labels=None):
    """registry -> host. Every `installed_at` entry THIS instance owns must match the row's ONE
    canonical sha256.

    This is the check that would have caught the AOE wrapper years earlier. It differs from
    HASH_DRIFT in what it iterates: HASH_DRIFT walks rows and compares the row's single
    host_path, so a second installation of the same artifact on another host is invisible to it.
    This walks the REGISTRY, so every declared installation is asserted somewhere.

    Entries on other hosts are NOT silently skipped — they are returned as `deferred` so the log
    can say which instance owns them. A silently skipped entry reads identically to a passing one.
    """
    labels = labels if labels is not None else HOST_LABELS
    breaches, deferred = [], []
    for r in rows:
        reg = r.get("installed_at")
        if not reg or r.get("install_state") != "installed" or not r.get("sha256"):
            continue
        for e in reg:
            if e.get("host") not in labels:
                deferred.append(f"{r['id']}@{e.get('host')}")
                continue
            if r.get("repo_resident"):
                continue  # host_path IS the repo copy; the compare would be vacuous
            live = host_hashes.get(os.path.basename(e.get("path") or ""))
            if live is None:
                continue  # absence is DARK/ORPHAN's business
            if live != r["sha256"]:
                breaches.append({"id": r["id"], "host": e.get("host"),
                                 "canonical": r["sha256"][:12], "live": live[:12]})
    return {"breaches": breaches, "deferred": sorted(deferred)}


def check_no_backup(rows, backups, labels=None):
    """host -> host. A `load-bearing` artifact installed here with no `*.bak*` beside it.

    Detection without recovery is half a guard: the daily reconciler catches a HASH_DRIFT within
    24h, but the backup is what makes that drift REVERSIBLE. Scoped to load-bearing rows so it
    stays an actionable list rather than a wall.
    """
    labels = labels if labels is not None else HOST_LABELS
    if backups is None:
        return []
    out = []
    for r in rows:
        if r.get("install_state") != "installed" or r.get("criticality") != "load-bearing":
            continue
        if r.get("repo_resident") or not r.get("sha256"):
            continue  # repo-resident rows are recoverable from git; null-sha rows are self-referential
        for e in entries_for_host(r, labels):
            base = os.path.basename(e.get("path") or "")
            if not base:
                continue
            if not any(b.startswith(base + ".") or b.startswith(base) and ".bak" in b for b in backups):
                out.append({"id": r["id"], "host": e.get("host"), "artifact": base})
    return out


def load_doc_path_claims(path=None):
    """The prescriptive docs' host-path claims (OPS-CLAIM-VERIFIER-COVERAGE-W1).

    Resolved by the SAME sibling rule as the inventory, for the same measured reason: deriving a
    path from __file__'s grandparent is correct in a checkout and resolves to `/ops/monitoring/...`
    on a host, which is how this reconciler's own first unattended run reconciled NOTHING.

    Returns [] when the file is absent — a host that predates the install must not start failing —
    and the caller logs that as SKIPPED, never as a pass.
    """
    p = Path(path) if path else Path(os.environ.get("DOC_PATH_CLAIMS_PATH", "")) if os.environ.get(
        "DOC_PATH_CLAIMS_PATH") else None
    if p is None:
        sibling = Path(__file__).resolve().parent / "doc-host-path-claims.json"
        p = sibling if sibling.exists() else REPO_ROOT / "ops/monitoring/doc-host-path-claims.json"
    try:
        return json.loads(p.read_text()).get("claims", [])
    except FileNotFoundError:
        return []
    except Exception as exc:
        log(f"DOC_PATH_CLAIMS_LOAD_FAILED: {exc} (path {p}) — fail-open, NOT a pass")
        return []


def check_doc_path_claims(claims, labels=None, exists=None):
    """docs -> host. Every host-path a prescriptive doc asserts is verified LOCALLY, on the host
    that owns it, by the daily run that is already there.

    W1 shipped these 9 claims UNPROBED behind a --probe-hosts flag because CI has no prod SSH and
    must never get any. But on these hosts the paths are ordinary local files, so the probe needs
    no SSH at all — it needs to run somewhere else. This is that somewhere else.

    Three outcomes, deliberately distinct (an unprobed claim is not a passing claim — the
    verdict-token principle at per-check granularity):
      MISSING   expect=present and the path is not here          -> finding
      REVIEW    expect=absent  and the path IS here              -> finding (an inverse claim that
                                                                    silently came true)
      DEFERRED  owned by another instance's labels               -> reported, never silently skipped

    Returns {"findings": [...], "probed": [...], "deferred": [...]} so the caller can emit POSITIVE
    per-claim output. Never mutates anything: a doc that disagrees with the host is corrected by a
    human, because a job that edits its own operating manual is a category error.
    """
    labels = labels if labels is not None else HOST_LABELS
    exists = exists if exists is not None else (lambda p: Path(p).exists())
    findings, probed, deferred = [], [], []
    for c in claims:
        path = (c.get("path") or "").rstrip("/")
        owners = set(c.get("hosts") or [])
        if not path:
            continue
        if not owners & labels:
            deferred.append({"path": path, "hosts": sorted(owners)})
            continue
        expect = c.get("expect", "present")
        here = bool(exists(path))
        if expect == "absent":
            verdict = "OK" if not here else "REVIEW"
        else:
            verdict = "OK" if here else "MISSING"
        probed.append({"path": path, "expected": expect,
                       "observed": "present" if here else "absent", "verdict": verdict})
        if verdict != "OK":
            findings.append({"path": path, "expected": expect,
                             "observed": "present" if here else "absent",
                             "verdict": verdict, "source": c.get("source", "")})
    return {"findings": findings, "probed": probed, "deferred": deferred}


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


# ─────────── POSTURE_DRIFT (OPS-HOST-EXPOSURE-POSTURE-W1) ───────────
#
# The 9th check. Every other check compares a committed artifact against the host filesystem;
# this one compares the DECLARED inbound posture against what is actually reachable, probed from
# a real off-box vantage — the peer host. `ss` on the box cannot answer "is this reachable from
# the internet"; only something outside the box can, which is why this check probes the PEER
# rather than localhost.
#
# It never mutates a firewall. Detection and alerting only: an unattended job must not change a
# network rule. That limit is deliberate, not a gap.


def _resolve_posture_path():
    """Same sibling rule as the inventory — correct in a checkout AND at /opt/algovault-monitoring."""
    env = os.environ.get("NETWORK_POSTURE_PATH")
    if env:
        return Path(env)
    sibling = Path(__file__).resolve().parent / "network-posture.json"
    if sibling.exists():
        return sibling
    return REPO_ROOT / "ops/monitoring/network-posture.json"


POSTURE_PATH = _resolve_posture_path()
POSTURE_PROBE_TIMEOUT = float(os.environ.get("POSTURE_PROBE_TIMEOUT", "6"))


def peer_address(label):
    """Opaque label → address, from the ENVIRONMENT only.

    Never from network-posture.json: that file is committed to a PUBLIC repo and is required to
    stay address-free. Set POSTURE_PEER_AOE_1 / POSTURE_PEER_SIGNAL_1 in the host's cron env.
    Returns None when unset, which makes the probe SKIP loudly rather than pass silently.
    """
    return os.environ.get("POSTURE_PEER_" + label.upper().replace("-", "_"))


def tcp_reachable(addr, port, timeout=None):
    """True/False reachability, or None when the probe itself could not run (fail-open)."""
    try:
        with socket.create_connection((addr, port), timeout=timeout or POSTURE_PROBE_TIMEOUT):
            return True
    except (ConnectionRefusedError, socket.timeout, TimeoutError):
        return False
    except OSError as exc:
        # Refused/unreachable are ANSWERS; anything else (DNS failure, no route, local socket
        # exhaustion) means the prober is broken, and a broken prober must never read as a clean
        # posture — the false-green shape OPS-FRESHNESS-SOURCE-TRUTH-W1 codified.
        if exc.errno in (errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH):
            return False
        return None


def expected_open_from(rule, prober_labels):
    """SINGLE DERIVATION of expected peer reachability — see _expected_from_peer_derivation.

    Reachable from the prober IFF the rule allows `any`, or names the prober's own label. A rule
    restricted to `cloudflare` is therefore expected CLOSED from a peer host, and reporting that
    as an outage would be the obvious false fire.
    """
    srcs = rule.get("allowed_sources") or []
    if "any" in srcs:
        return True
    return any(lbl in srcs for lbl in prober_labels)


def check_posture_drift(labels=None, posture=None, probe=None, resolve=None):
    """Probe every peer host's declared ports from HERE. Returns findings + positive per-port rows.

    Findings are the two directions that both matter:
      UNEXPECTED_OPEN   — reachable but not declared reachable from here. The next accidentally
                          published port lands here on its first cycle.
      UNEXPECTED_CLOSED — declared reachable from here but not reachable. That is an outage
                          signal, not a posture nit.

    `probe` and `resolve` are injectable so --self-test can exercise BOTH directions hermetically —
    no sockets, no network, no dependence on the live posture of either host.
    """
    labels = labels if labels is not None else HOST_LABELS
    probe = probe or tcp_reachable
    resolve = resolve or peer_address
    out = {"findings": [], "probed": [], "skipped": []}

    if posture is None:
        try:
            posture = json.loads(POSTURE_PATH.read_text())
        except Exception as exc:
            out["skipped"].append({"reason": "POSTURE_LOAD_FAILED",
                                   "path": str(POSTURE_PATH), "error": str(exc)[:160]})
            return out

    for target, cfg in (posture.get("hosts") or {}).items():
        if target in labels:
            continue  # a host cannot be its own off-box vantage
        addr = resolve(target)
        if not addr:
            out["skipped"].append({
                "reason": "PEER_ADDRESS_UNSET", "target": target,
                "hint": "set POSTURE_PEER_" + target.upper().replace("-", "_") + " in the cron env"})
            continue

        # Declared-reachable ports, plus every loopback-only port — the latter are expected CLOSED,
        # and probing them is exactly what catches a future rebind from 127.0.0.1 to 0.0.0.0.
        probes = []
        for rule in cfg.get("inbound", []):
            if rule.get("proto") != "tcp" or rule.get("port") is None:
                continue  # icmp/udp are declared but not port-probed; see not_port_probed
            probes.append((rule["port"], expected_open_from(rule, labels), "inbound"))
        for rule in cfg.get("loopback_only", []):
            if rule.get("proto", "tcp").startswith("tcp") and rule.get("port") is not None:
                probes.append((rule["port"], False, "loopback_only"))

        for port, expect_open, origin in sorted(set(probes)):
            actual = probe(addr, port)
            if actual is None:
                out["skipped"].append({"reason": "PROBE_FAILED", "target": target, "port": port})
                continue
            verdict = "OK" if actual == expect_open else (
                "UNEXPECTED_OPEN" if actual else "UNEXPECTED_CLOSED")
            # POSITIVE per-port row — port + observed state + verdict. Never absence-of-alert:
            # a port silently skipped by a load error must not look like a port that passed.
            out["probed"].append({"target": target, "port": port, "origin": origin,
                                  "expected": "open" if expect_open else "closed",
                                  "observed": "open" if actual else "closed", "verdict": verdict})
            if verdict != "OK":
                out["findings"].append({"target": target, "port": port, "verdict": verdict,
                                        "origin": origin,
                                        "expected": "open" if expect_open else "closed"})
    return out


# ─────────── main ───────────

def evaluate(rows, host_hashes, crontab_text, backups=None, labels=None, posture_result=None,
             doc_claims_result=None):
    """`rows` is the OWNED subset; ORPHAN alone needs the full set to know what is known.

    `posture_result` and `doc_claims_result` are passed in rather than computed here so each probe
    runs EXACTLY once per invocation — its positive per-item rows and its findings are two
    projections of one derivation, not two independent probes that could disagree.
    """
    labels = labels if labels is not None else HOST_LABELS
    return {
        "HASH_DRIFT": check_hash_drift(rows, host_hashes),
        "ORPHAN": check_orphan(rows, host_hashes),
        "DARK": check_dark(rows, crontab_text, labels),
        "SCHEDULE_DRIFT": check_schedule_drift(rows, crontab_text, labels),
        "PENDING_STALE": check_pending_stale(rows),
        "REGISTRY_PARITY": check_registry_parity(rows, host_hashes, labels)["breaches"],
        "NO_BACKUP": check_no_backup(rows, backups, labels),
        "POSTURE_DRIFT": (posture_result or {}).get("findings", []),
        "DOC_PATH_CLAIM": (doc_claims_result or {}).get("findings", []),
        "DIVERGENT_COPY": divergent_copy_findings(rows),
    }


def main(check_mode=False):
    try:
        doc = json.loads(INVENTORY_PATH.read_text())
        rows = doc["artifacts"]
    except Exception as exc:
        # Fail-OPEN on the box (exit 0 — the reconciler must never break the host) but never
        # fail-SILENT: an inventory this process cannot read means the guard is DARK, and a dark
        # guard that exits 0 is indistinguishable from a healthy one. It therefore feeds the same
        # breach streak and pages through the wrapper, which needs no inventory to work.
        log(f"INVENTORY_LOAD_FAILED: {exc} (resolved path: {INVENTORY_PATH}) — the reconciler is "
            f"DARK; exit 0 (fail-open) but escalating")
        if not check_mode:
            streak = update_breach_streak(True)
            log(f"BREACH_STREAK {streak}/{CONSECUTIVE_TO_PAGE} (cause: INVENTORY_LOAD_FAILED)")
            if streak >= CONSECUTIVE_TO_PAGE:
                call_wrapper(
                    f"🛑 {ALERT_ID}\n"
                    f"Condition: the monitoring reconciler cannot READ its inventory "
                    f"({CONSECUTIVE_TO_PAGE} consecutive runs) — every check is DARK\n"
                    f"  resolved path: {INVENTORY_PATH}\n  error: {exc}\n"
                    f"State: breach streak {streak}\n"
                    f"Action: dispatch {RECOMMENDED_WAVE} via Cowork → Claude Code\n"
                    f"Source log: /var/log/monitoring-inventory-reconcile.log")
                log(f"ALERT_SENT {ALERT_ID} (INVENTORY_LOAD_FAILED)")
        return 1 if check_mode else 0
    owned = [r for r in rows if owns_row(r, HOST_LABELS)]
    if not check_mode:
        log(f"START monitoring-inventory-reconcile labels={sorted(HOST_LABELS)} "
            f"owned={len(owned)}/{len(rows)} inventory={INVENTORY_PATH}")
    if not owned:
        log(f"NO_OWNED_ROWS for labels={sorted(HOST_LABELS)} — misconfigured "
            "MONITORING_HOST_LABELS would otherwise report a silent all-clear; exit 0 (fail-open)")
        return 0

    host_hashes = host_listing()
    crontab_text = host_crontab()
    if host_hashes is None or crontab_text is None:
        log("HOST_UNREACHABLE — cannot reconcile; exit 0 (fail-open, the reconciler must never "
            "be the thing that breaks the box)")
        return 0
    backups = host_backups()

    posture_result = check_posture_drift(HOST_LABELS)
    doc_claims = load_doc_path_claims()
    doc_claims_result = check_doc_path_claims(doc_claims, HOST_LABELS)

    f = evaluate(owned, host_hashes, crontab_text, backups, HOST_LABELS, posture_result,
                 doc_claims_result)
    # DIVERGENT_COPY is a standing report, not a drift breach — it cannot self-resolve here.
    drift_keys = ("HASH_DRIFT", "ORPHAN", "DARK", "SCHEDULE_DRIFT", "PENDING_STALE",
                  "REGISTRY_PARITY", "NO_BACKUP", "POSTURE_DRIFT", "DOC_PATH_CLAIM")
    drifted = any(f[k] for k in drift_keys)

    if not check_mode:
        # POSITIVE per-check output — never absence-of-alert. A check silently skipped by a load
        # error must not read identically to a check that passed.
        for k in drift_keys + ("DIVERGENT_COPY",):
            v = f[k]
            log(f"CHECK {k}: {'BREACH ' + json.dumps(v) if v else 'OK (empty set)'}")
        # Positive accounting for what this instance did NOT evaluate — a registry entry owned by
        # another host must be visibly deferred, never silently absent.
        rp = check_registry_parity(owned, host_hashes, HOST_LABELS)
        log(f"REGISTRY_COVERAGE: asserted_here={sum(len(entries_for_host(r, HOST_LABELS)) for r in owned if r.get('installed_at'))} "
            f"deferred_to_other_instances={rp['deferred'] or 'none'}")
        # POSITIVE per-port accounting for the network probe: port + observed state + verdict for
        # EVERY port probed, and a loud row for every port that could NOT be probed. A dark prober
        # exiting 0 must never be indistinguishable from a clean posture.
        for row in posture_result.get("probed", []):
            log(f"POSTURE {row['target']}:{row['port']}/tcp ({row['origin']}) "
                f"expected={row['expected']} observed={row['observed']} -> {row['verdict']}")
        for sk in posture_result.get("skipped", []):
            log(f"POSTURE_SKIPPED {json.dumps(sk)} — fail-open, NOT a pass")
        if not posture_result.get("probed") and not posture_result.get("skipped"):
            log("POSTURE_DRIFT: no peer host to probe from this instance (single-host posture)")
        # POSITIVE per-claim accounting for the docs' host-path claims: path + expectation +
        # observed state + verdict for EVERY claim this instance owns, and an explicit DEFERRED
        # line for every claim it does not. A claim silently skipped must never read as passing.
        for row in doc_claims_result.get("probed", []):
            log(f"DOC_PATH_CLAIM {row['path']} expected={row['expected']} "
                f"observed={row['observed']} -> {row['verdict']}")
        deferred_claims = doc_claims_result.get("deferred", [])
        if deferred_claims:
            log(f"DOC_PATH_CLAIM_DEFERRED to other instances: "
                f"{json.dumps([d['path'] + '@' + ','.join(d['hosts']) for d in deferred_claims])}")
        if not doc_claims:
            log("DOC_PATH_CLAIM: SKIPPED — doc-host-path-claims.json not installed here "
                "(fail-open, NOT a pass)")
        if backups is None:
            log("NO_BACKUP: SKIPPED — backup listing unavailable (fail-open, not a pass)")
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

    # ── 6. REGISTRY_PARITY — the generator-level check (multi-host) ──
    L = {"signal-1"}
    shared = lambda **kw: {"id": "w", "host": "signal-1",
                           "host_path": "/opt/algovault-monitoring/w.sh",
                           "installed_at": [{"host": "signal-1", "path": "/opt/algovault-monitoring/w.sh"},
                                            {"host": "aoe-1", "path": "/opt/algovault-monitoring/w.sh"}],
                           "install_state": "installed", "sha256": "c" * 64, "kind": "executable", **kw}
    ck("registry entry matching canonical -> clean",
       check_registry_parity([shared()], {"w.sh": "c" * 64}, L)["breaches"], [])
    rp = check_registry_parity([shared()], {"w.sh": "d" * 64}, L)
    ck("owned entry diverging from canonical -> BREACH", len(rp["breaches"]), 1)
    ck("breach names the host", rp["breaches"][0]["host"], "signal-1")
    ck("the OTHER host's entry is DEFERRED, never silently skipped", rp["deferred"], ["w@aoe-1"])
    ck("from aoe-1's side the same row is owned and asserted there",
       len(check_registry_parity([shared()], {"w.sh": "d" * 64}, {"aoe-1"})["breaches"]), 1)
    ck("rows without a registry are not registry-checked",
       check_registry_parity([{"id": "x", "install_state": "installed", "sha256": "c" * 64,
                               "host_path": "/opt/algovault-monitoring/x.sh"}], {"x.sh": "d" * 64}, L)["breaches"], [])
    # The exact miss this check exists to prevent: one host updated, the other left on the ancestor.
    ck("THE REGRESSION: canonical updated, aoe-1 still on the ancestor -> aoe-1 instance breaches",
       len(check_registry_parity([shared()], {"w.sh": "938d" + "0" * 60}, {"aoe-1"})["breaches"]), 1)

    # ── 7. NO_BACKUP — a convention turned into an assertion ──
    ck("load-bearing artifact WITH a .bak -> clean",
       check_no_backup([shared(criticality="load-bearing")],
                       {"w.sh.bak.PRE-SOMETHING-20260729T000000Z"}, L), [])
    ck("load-bearing artifact with NO .bak -> breach",
       len(check_no_backup([shared(criticality="load-bearing")], set(), L)), 1)
    ck("a backup for a DIFFERENT artifact does not count",
       len(check_no_backup([shared(criticality="load-bearing")], {"other.sh.bak.X"}, L)), 1)
    ck("supporting criticality is out of scope (stays actionable, not a wall)",
       check_no_backup([shared(criticality="supporting")], set(), L), [])
    ck("repo-resident rows are exempt (git IS the backup)",
       check_no_backup([shared(criticality="load-bearing", repo_resident=True)], set(), L), [])
    ck("unreachable backup listing -> fail-open, NOT a pass",
       check_no_backup([shared(criticality="load-bearing")], None, L), [])

    # ── 8. host ownership / per-host schedule ──
    ck("row owned via its registry entry", owns_row(shared(), {"aoe-1"}), True)
    ck("row NOT owned by a foreign label", owns_row(shared(), {"other-1"}), False)
    ck("legacy row without a registry is owned via its own host field",
       owns_row({"id": "l", "host": "204.168.185.24", "host_path": "/x"}, {"204.168.185.24"}), True)
    per_host = shared(schedule="57 6 * * *",
                      installed_at=[{"host": "signal-1", "path": "/opt/algovault-monitoring/w.sh",
                                     "schedule": "57 6 * * *"},
                                    {"host": "aoe-1", "path": "/opt/algovault-monitoring/w.sh",
                                     "schedule": "17 7 * * *"}])
    ck("per-host schedule wins on signal-1", schedule_for(per_host, {"signal-1"}), "57 6 * * *")
    ck("per-host schedule wins on aoe-1", schedule_for(per_host, {"aoe-1"}), "17 7 * * *")
    ck("a row scheduled only on the OTHER host is not DARK here",
       check_dark([shared(schedule=None,
                          installed_at=[{"host": "aoe-1", "path": "/opt/algovault-monitoring/w.sh",
                                         "schedule": "17 7 * * *"}])], CRON, {"signal-1"}), [])

    # ── 9. inventory path resolution — the defect that made the FIRST live run reconcile nothing ──
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        host_like = Path(td) / "opt" / "algovault-monitoring"
        host_like.mkdir(parents=True)
        (host_like / "monitoring-inventory.json").write_text("{}")
        script = host_like / "monitoring-inventory-reconcile.py"
        script.write_text("#")
        sibling = script.resolve().parent / "monitoring-inventory.json"
        ck("host layout: inventory resolves to the SIBLING, not /ops/...", sibling.exists(), True)
        grandparent_rule = script.resolve().parent.parent.parent / "ops/monitoring/monitoring-inventory.json"
        ck("the OLD grandparent rule would NOT resolve on a host (this is the bug)",
           grandparent_rule.exists(), False)
    ck("the live reconciler resolved a real inventory", INVENTORY_PATH.exists(), True)

    # ── the reconciler is row 1 of its own inventory ──
    try:
        doc = json.loads(INVENTORY_PATH.read_text())
        ids = [r["id"] for r in doc["artifacts"]]
        ck("reconciler is registered in its own inventory", "monitoring-inventory-reconcile" in ids, True)
        ck("inventory is registered too", "monitoring-inventory" in ids, True)
        # The shared primitives must KEEP their registry — dropping it would silently restore
        # the single-call-site blindness this wave retired.
        for rid in ("send-telegram-wrapper", "monitoring-inventory-reconcile"):
            row = next((r for r in doc["artifacts"] if r["id"] == rid), None)
            hosts = {e.get("host") for e in (row or {}).get("installed_at", [])}
            ck(f"{rid} declares a multi-host registry", len(hosts) >= 2, True)
        wrapper = next((r for r in doc["artifacts"] if r["id"] == "send-telegram-wrapper"), None)
        # NOTE: deliberately NOT asserting "zero unreconciled divergent copies" here.
        # DIVERGENT_COPY is a STANDING REPORT, not a gate. Asserting it would mean a future wave
        # that honestly records a newly-found divergence fails this suite — pressure to clear the
        # field dishonestly. The reconciler reports it every run; that is the right mechanism.
        ck("the ADR exemption is machine-recorded, not prose-only",
           bool((wrapper or {}).get("exempt_consumers")), True)
        # This repo is PUBLIC: new rows use opaque labels, never addresses.
        import re as _re
        new_leaks = [r["id"] for r in doc["artifacts"]
                     if r.get("installed_at") and _re.search(r"\b\d{1,3}(\.\d{1,3}){3}\b",
                                                             json.dumps(r.get("installed_at")))]
        ck("no registry entry carries a literal address", new_leaks, [])
    except Exception as exc:
        failures.append(f"inventory self-registration: {exc}")

    # ── 9. POSTURE_DRIFT, both directions, hermetically (injected probe + resolver) ──
    POSTURE = {"hosts": {
        "me-1": {"inbound": [{"port": 22, "proto": "tcp", "allowed_sources": ["any"]}]},
        "peer-1": {
            "inbound": [
                {"port": 22, "proto": "tcp", "allowed_sources": ["any"]},
                {"port": 443, "proto": "tcp", "allowed_sources": ["cloudflare"]},
                {"port": 8080, "proto": "tcp", "allowed_sources": []},
                {"port": None, "proto": "icmp", "allowed_sources": ["any"]},
                {"port": 443, "proto": "udp", "allowed_sources": ["any"]},
            ],
            "loopback_only": [{"port": 5432, "proto": "tcp"}],
        }}}
    ME = {"me-1"}
    res = lambda t: "203.0.113.9"          # RFC-5737 documentation address
    pd = lambda open_ports: check_posture_drift(
        ME, POSTURE, probe=lambda a, p: p in open_ports, resolve=res)

    healthy = pd({22})
    ck("healthy posture -> zero findings", healthy["findings"], [])
    ck("a host never probes itself", [r["target"] for r in healthy["probed"] if r["target"] == "me-1"], [])
    ck("icmp/udp declared but NOT port-probed",
       sorted({r["port"] for r in healthy["probed"]}), [22, 443, 5432, 8080])
    ck("cloudflare-restricted :443 is expected CLOSED from a peer (the obvious false fire)",
       [r["verdict"] for r in healthy["probed"] if r["port"] == 443], ["OK"])
    ck("positive per-port rows carry port+observed+verdict",
       all({"port", "observed", "verdict", "expected"} <= set(r) for r in healthy["probed"]), True)

    # direction 1 — a port that should not be reachable, is. The next stray published port.
    o = pd({22, 8080})["findings"]
    ck("UNEXPECTED_OPEN fires", [(f["port"], f["verdict"]) for f in o], [(8080, "UNEXPECTED_OPEN")])
    ck("a loopback_only port rebound to 0.0.0.0 is caught",
       [(f["port"], f["verdict"]) for f in pd({22, 5432})["findings"]], [(5432, "UNEXPECTED_OPEN")])

    # direction 2 — a port that should be reachable, is not. An outage signal, not a nit.
    c = pd(set())["findings"]
    ck("UNEXPECTED_CLOSED fires", [(f["port"], f["verdict"]) for f in c], [(22, "UNEXPECTED_CLOSED")])

    # fail-open, but never fail-SILENT: an unprobeable peer is a loud skip, not a pass.
    unset = check_posture_drift(ME, POSTURE, probe=lambda a, p: True, resolve=lambda t: None)
    ck("unresolvable peer -> skipped, not a finding", unset["findings"], [])
    ck("unresolvable peer -> loud skip row",
       [s["reason"] for s in unset["skipped"]], ["PEER_ADDRESS_UNSET"])
    broke = check_posture_drift(ME, POSTURE, probe=lambda a, p: None, resolve=res)
    ck("a broken prober reports SKIPPED, never a clean posture", broke["findings"], [])
    ck("a broken prober emits one skip row per port", len(broke["skipped"]), 4)
    ck("unreadable posture file -> skip, not a pass",
       check_posture_drift(ME, {"hosts": {}}, probe=lambda a, p: True, resolve=res)["findings"], [])

    # ── DOC_PATH_CLAIM (OPS-CLAIM-VERIFIER-COVERAGE-W1) ──
    # W1 shipped these claims UNPROBED behind a --probe-hosts flag CI can never use. Here they are
    # local files, so the only thing that was ever missing is a place to run the check.
    CLAIMS = [
        {"path": "/opt/algovault-monitoring/send_telegram.sh", "hosts": ["signal-1", "aoe-1"], "expect": "present"},
        {"path": "/opt/algovault-monitoring/website-drift-canary.py", "hosts": ["signal-1"], "expect": "present"},
        {"path": "/opt/algovault-monitoring/autopilot-framework.py", "hosts": ["signal-1", "aoe-1"], "expect": "absent"},
        {"path": "/opt/crypto-quant-signal-mcp/", "hosts": ["signal-1"], "expect": "present"},
    ]
    SIG = {"signal-1"}
    here = lambda present: (lambda p: p in present)  # noqa: E731 — fixture seam, mirrors probe=

    # healthy: everything present except the inverse claim, which must stay absent
    ok = check_doc_path_claims(CLAIMS, SIG, exists=here({
        "/opt/algovault-monitoring/send_telegram.sh",
        "/opt/algovault-monitoring/website-drift-canary.py",
        "/opt/crypto-quant-signal-mcp"}))
    ck("healthy doc claims -> zero findings", ok["findings"], [])
    ck("positive per-claim rows carry path+expected+observed+verdict",
       all({"path", "expected", "observed", "verdict"} <= set(r) for r in ok["probed"]), True)
    ck("a trailing slash does not make a directory claim unverifiable",
       [r["verdict"] for r in ok["probed"] if r["path"].endswith("signal-mcp")], ["OK"])

    # direction 1 — a path the docs promise is GONE (the moved-file class, 2 of W1's 5 positives)
    gone = check_doc_path_claims(CLAIMS, SIG, exists=here({
        "/opt/algovault-monitoring/website-drift-canary.py", "/opt/crypto-quant-signal-mcp"}))
    ck("MISSING fires when a prescribed path is absent",
       [(f["path"], f["verdict"]) for f in gone["findings"]],
       [("/opt/algovault-monitoring/send_telegram.sh", "MISSING")])

    # direction 2 — an INVERSE claim that silently came true ("extract at the 3rd consumer")
    built = check_doc_path_claims(CLAIMS, SIG, exists=here({
        "/opt/algovault-monitoring/send_telegram.sh",
        "/opt/algovault-monitoring/website-drift-canary.py",
        "/opt/algovault-monitoring/autopilot-framework.py",
        "/opt/crypto-quant-signal-mcp"}))
    ck("REVIEW fires when an 'absent until' path exists",
       [(f["path"], f["verdict"]) for f in built["findings"]],
       [("/opt/algovault-monitoring/autopilot-framework.py", "REVIEW")])

    # ownership — another host's claim is DEFERRED, never silently skipped, and never a finding
    aoe = check_doc_path_claims(CLAIMS, {"aoe-1"}, exists=here({
        "/opt/algovault-monitoring/send_telegram.sh"}))
    ck("aoe-1 owns only the shared wrapper + the inverse claim",
       sorted(r["path"] for r in aoe["probed"]),
       ["/opt/algovault-monitoring/autopilot-framework.py",
        "/opt/algovault-monitoring/send_telegram.sh"])
    ck("signal-1-only claims are DEFERRED on aoe-1, not MISSING", aoe["findings"], [])
    ck("deferred claims are reported, never silently dropped",
       sorted(d["path"] for d in aoe["deferred"]),
       ["/opt/algovault-monitoring/website-drift-canary.py", "/opt/crypto-quant-signal-mcp"])

    # vacuity — an absent manifest yields nothing to check, and the caller must say so
    ck("no claims -> no probed rows (caller logs SKIPPED, not a pass)",
       check_doc_path_claims([], SIG, exists=here(set()))["probed"], [])

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

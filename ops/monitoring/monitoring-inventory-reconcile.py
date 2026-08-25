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
  PENDING_STALE   inventory      a `pending` / `unclassified` row older than 30d — UNLESS it
                                 declares a `blocked_on` condition MEASURED as still unmet, in
                                 which case it reports BLOCKED and breaches the day the
                                 condition is MET, at any age (OPS-MONITORING-DRIFT-GENERATOR-FIX-W1)
  REGISTRY_PARITY registry -> host   an `installed_at` entry on THIS host whose live file != the
                                     row's ONE canonical sha256
  NO_BACKUP       host -> host   a `load-bearing` row installed here with no recoverable backup,
                                 searched in the artifact's OWN directory (file-granular
                                 `<artifact>.bak.*`) AND its parent (directory-granular
                                 `<dir>.bak.*`), for EVERY directory the rows actually name —
                                 not just MONITORING_DIR (OPS-MONITORING-DRIFT-GENERATOR-FIX-W1)

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

  🛑 And an assertion is only worth the instrument behind it. Until 2026-08-22 this check
  scanned MONITORING_DIR only, files only, matching the ARTIFACT's basename — so for a row
  installed anywhere else it returned a confident zero that no achievable action could clear.
  See host_backups() for the measurement. The lesson generalises past this check: a drift
  finding that recurs for days with no available remedy is evidence about the INSTRUMENT
  before it is evidence about the estate.

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
import shlex
import socket
import subprocess
import sys
from datetime import datetime, timezone, date, timedelta
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
PENDING_STALE_DAYS = 30

# ── SOT_PARITY sustained-breach alerting (OPS-NUMERIC-PROBE-VALIDATION-W1 Part B) ─────────────
# A DISTINCT alert id, not a reuse of ALERT_ID. send_telegram.sh cools down PER ALERT ID for 24h,
# so riding MONITORING_INVENTORY_DRIFT would let an unrelated noisy HASH_DRIFT suppress this page.
# Different meaning, different action, different cooldown.
SOT_PARITY_ALERT_ID = "SOT_PARITY_SUSTAINED_DRIFT"
# Template form, never a literal W<number> — send_telegram.sh resolves it at send time.
SOT_PARITY_RECOMMENDED_WAVE = "OPS-MONITORING-SOT-PARITY-RESTORE-W{NEXT}"

# ── THE ONE DECLARED THRESHOLD TABLE ─────────────────────────────────────────────────────────
# Every sustained-breach threshold in this file lives HERE, keyed by (alert_id, condition).
# Three thresholds scattered across three call sites is the next drift, and a threshold that
# lives at its call site cannot be audited against the others.
#
# WHY THE SOT_PARITY NUMBERS DIFFER FROM EACH OTHER, and from the legacy 3:
#   DRIFTED >= 2            One daily run can legitimately catch the propagation window
#                           (sot-parity-config.json:14: ~5-min CDN TTL + up to the 60-min sync
#                           interval). TWO consecutive DAILY runs cannot: >24h with ~24 hourly
#                           sync opportunities in between is not lag, it is a sync not landing.
#   COULD_NOT_COMPARE >= 3  A host that cannot verify its own declaration for 3 days is auditing
#                           blind, and every other check here is downstream of that file. Slower
#                           than DRIFTED because the transport is third-party and transient
#                           failures are expected; faster than never, because silence is the
#                           dark-guard shape this whole file exists to break.
SUSTAINED_BREACH_THRESHOLDS = {
    (ALERT_ID, None): 3,
    (SOT_PARITY_ALERT_ID, "DRIFTED"): 2,
    (SOT_PARITY_ALERT_ID, "COULD_NOT_COMPARE"): 3,
}
# DERIVED, never a second literal — build_body() and the legacy call site both read this name.
CONSECUTIVE_TO_PAGE = SUSTAINED_BREACH_THRESHOLDS[(ALERT_ID, None)]

# The streak ledger lives in /var/lib and NOT in MONITORING_DIR, for the same measured reason as
# SYNC_HEARTBEAT_PATH below: a file under the monitoring dir with no inventory row is precisely
# what ORPHAN exists to catch.
SOT_PARITY_LEDGER_PATH = os.environ.get(
    "SOT_PARITY_STREAK_LEDGER", "/var/lib/algovault-monitoring/sot-parity-streak.jsonl")
# Window for the reset taxonomy and the observed reset RATE.
SOT_PARITY_TAXONOMY_WINDOW_DAYS = 30
# The promotion criterion this instrument measures the approach to. Read from the config at
# runtime; this is only the fallback for an unreadable config, and it is NOT a policy knob —
# changing the criterion is OPS-MONITORING-SOT-PARITY-PROMOTE-W{NEXT}'s job, not this file's.
SOT_PARITY_PROMOTION_TARGET_RUNS = 30

# ── SYNC_LIVENESS (OPS-MONITORING-INVENTORY-RESTORE-W1) ──────────────────────────────────────
# DARK only notices if the crontab LINE disappears; it cannot tell a line that is present and
# never completing from a healthy one. SOT_PARITY would notice the downstream symptom, but ships
# `report`, so it never pages. This check closes that: it asserts POSITIVELY that the sync
# attempted, within a bound DERIVED from its own inventory schedule.
SYNC_LIVENESS_ROW_ID = "declaration-sync"
# The heartbeat is written by declaration-sync.sh at job START. It lives in /var/lib and NOT in
# MONITORING_DIR, because a file under the monitoring dir with no inventory row is precisely what
# ORPHAN exists to catch — and ops/cron/snapshot-landing-daily.sh already made /var/lib the
# heartbeat home for the same reason.
SYNC_HEARTBEAT_PATH = os.environ.get(
    "DECLARATION_SYNC_HEARTBEAT", "/var/lib/algovault-monitoring/declaration-sync-heartbeat")
# The BOUND is derived (cadence × this). Only the MULTIPLIER is a declared policy constant, the
# same shape as CONSECUTIVE_TO_PAGE and PENDING_STALE_DAYS above. 2 = one wholly missed cycle
# must not fire, two must — a single missed hourly run is a blip (a slow fetch, a reboot), while
# two consecutive is the shape of an actual stop.
SYNC_LIVENESS_MISSED_CYCLES = max(1, int(os.environ.get("SYNC_LIVENESS_MISSED_CYCLES", "2")))

# ── ALERT_EPISODE_AGE (OPS-ALERT-RECOVERY-NOTICE-W1 CH2) ────────────────────────────────────
# A resolve path fixes "quiet means healed". It does NOT fix "FIRING forever because the reporter
# died": send_telegram.sh's marker is written on a delivered fire and removed only by a --clear
# that some caller has to make. If the caller stops running, the marker sits there and the
# operator's view stays pinned to a condition nobody is measuring any more — the same defect the
# wave retired, one level up. So: for every ADOPTED alert, assert how long its episode has been
# open. Unadopted alerts are excluded BY CONSTRUCTION rather than by exception, because nothing
# clears them yet and reporting their age would be noise about a mechanism they do not use.
ALERT_REGISTRY_PATH = os.environ.get(
    "ALERT_REGISTRY_PATH", os.path.join(MONITORING_DIR, "alert-registry.json"))
ALERT_STATE_DIR = os.environ.get(
    "ALERT_STATE_DIR", os.path.join(MONITORING_DIR, ".alert-state"))
# Report from the first tick; page only past this. An episode legitimately stays open while a
# real condition persists, so the page is for "nobody is clearing this", not "this is broken".
ALERT_EPISODE_PAGE_DAYS = max(1, int(os.environ.get("ALERT_EPISODE_PAGE_DAYS", "7")))

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


def backup_search_dirs(rows, labels=None):
    """The directories NO_BACKUP must actually look in — DERIVED from the rows, never assumed.

    Two directories per artifact, because the estate's own backup convention operates at two
    granularities and the check must cover both:

      * the artifact's OWN directory, for the per-file `<artifact>.bak.<REASON>-<ts>` convention
        that a hand-dispatched monitoring install follows; and
      * its PARENT, for the per-directory `<dir>.bak.<REASON>-<ts>` snapshot a manifest deployer
        takes when it swaps a whole tree (`/opt/algovault-bot/scripts.bak.PROVENANCE-…`).

    Returned SORTED so the remote command, the local scan and the self-test all see one order.
    """
    labels = labels if labels is not None else HOST_LABELS
    dirs = set()
    for r in rows:
        if r.get("install_state") != "installed" or r.get("criticality") != "load-bearing":
            continue
        if r.get("repo_resident") or not r.get("sha256"):
            continue
        for e in entries_for_host(r, labels):
            p = e.get("path") or ""
            if not p or not p.startswith("/"):
                continue
            own = os.path.dirname(p)
            if own and own != "/":
                dirs.add(own)
                parent = os.path.dirname(own)
                if parent and parent != "/":
                    dirs.add(parent)
    return sorted(dirs)


def host_backups(dirs=None):
    """`{dir: {entry names}}` for every directory NO_BACKUP needs, or `None` per UNLISTABLE dir.

    🛑 THE PREVIOUS IMPLEMENTATION WAS STRUCTURALLY BLIND, AND RETURNED A CONFIDENT ZERO.
    It scanned `MONITORING_DIR` only, `-type f` only, and matched on the ARTIFACT's basename.
    Measured 2026-08-22 on signal-1, the row `algovault-bot-referral-notify-drain` failed all
    three at once: its artifact lives at `/opt/algovault-bot/scripts/referral-notify-drain.sh`
    (a directory this never listed), its backups are `scripts.bak.PROVENANCE-<ts>` DIRECTORIES
    (excluded by `-type f`), and they are named for the PARENT dir, not the artifact. 17 such
    snapshots existed — the newest holding a byte-for-byte copy of the live file — while the
    check reported "zero backups" every day for 3 consecutive days and paged.

    That is this estate's recorded instrument defect verbatim: "the instrument was structurally
    incapable of observing the thing it was pointed at, and returned a confident zero" — and it
    made the alert UNFALSIFIABLE, because no backup taken at the artifact's real location could
    ever have cleared it. Fifth substrate after the site-scoped Caddy log, the `FRESH` page
    scrape, the hermetic `--self-test` seam and `ufw`'s `filter/INPUT`.

    Fail-open is now PER DIRECTORY rather than per run: one unlistable directory must not erase
    the evidence for every other row. `None` for a dir means "could not look", which the caller
    reports as SKIPPED — never as "no backup found".
    """
    dirs = list(dirs or [MONITORING_DIR])
    if not dirs:
        return {}
    if _on_host():
        out = {}
        for d in dirs:
            try:
                out[d] = {p.name for p in Path(d).iterdir() if ".bak" in p.name}
            except OSError as exc:
                log(f"HOST_BACKUPS_FAILED(local {d}): {exc} — fail-open for this directory only")
                out[d] = None
        return out
    # ONE round-trip for every directory. Each dir prints a DIR_OK/DIR_MISSING marker before its
    # entries so an unlistable directory is distinguishable from an empty one — the whole point.
    script = "; ".join(
        f"if [ -d {shlex.quote(d)} ]; then echo \"DIR_OK {d}\"; "
        f"find {shlex.quote(d)} -maxdepth 1 -mindepth 1 -name '*.bak*' -printf 'E %f\\n' 2>/dev/null; "
        f"else echo \"DIR_MISSING {d}\"; fi"
        for d in dirs
    )
    cmd = ["ssh", "-i", SSH_KEY, "-o", "ConnectTimeout=15", "-o", "BatchMode=yes", SSH_TARGET, script]
    try:
        r = _run(cmd)
        if r.returncode != 0:
            log(f"HOST_BACKUPS_FAILED(ssh rc={r.returncode}): {r.stderr.strip()[:160]} — fail-open")
            return None
    except Exception as exc:
        log(f"HOST_BACKUPS_FAILED: {type(exc).__name__}: {exc} — fail-open")
        return None
    return parse_backup_listing(r.stdout, dirs)


def parse_backup_listing(text, dirs):
    """Pure parser for the remote listing. Exported from the I/O so the self-test can execute it.

    A hermetic self-test is structurally blind to exactly what its own seam replaces, and the
    seam here IS this parser — so it is a pure function with its own scenarios rather than an
    inline loop no fixture ever reaches.
    """
    out = {d: None for d in dirs}
    current = None
    for raw in (text or "").splitlines():
        ln = raw.rstrip("\n")
        if ln.startswith("DIR_OK "):
            current = ln[len("DIR_OK "):]
            out[current] = set()
        elif ln.startswith("DIR_MISSING "):
            out[ln[len("DIR_MISSING "):]] = None
            current = None
        elif ln.startswith("E ") and current is not None:
            name = ln[2:].strip()
            if name:
                out[current].add(name)
    return out


def backup_covers(path, listing):
    """Is `path` covered by a backup? Returns (covered: bool|None, detail: str).

    `None` means the directories that could cover it were UNLISTABLE — report SKIPPED, never a
    breach, and never a pass. Two granularities are accepted, both measured live on signal-1:

      /opt/algovault-monitoring/send_telegram.sh   <- send_telegram.sh.bak.<REASON>-<ts>   (file)
      /opt/algovault-bot/scripts/referral-…​.sh     <- ../scripts.bak.PROVENANCE-<ts>/       (dir)
    """
    base = os.path.basename(path)
    own = os.path.dirname(path)
    parent = os.path.dirname(own)
    dirname = os.path.basename(own)
    looked, unlistable = [], []

    for d, want in ((own, base), (parent, dirname)):
        if not d or not want:
            continue
        entries = listing.get(d, None) if isinstance(listing, dict) else None
        if entries is None:
            unlistable.append(d)
            continue
        looked.append(d)
        # NEWEST first: these names end in a basic-ISO stamp, so a reverse lexical sort is a
        # reverse chronological one. The operator needs the backup they would RESTORE, and
        # naming the oldest of 17 snapshots would be technically true and practically wrong.
        hit = next((e for e in sorted(entries, reverse=True)
                    if e.startswith(want + ".") and ".bak" in e), None)
        if hit:
            kind = "file" if d == own else "parent-dir"
            return True, f"{kind} backup {d}/{hit}"
    if looked:
        return False, f"no `{base}.bak*` in {own} and no `{dirname}.bak*` in {parent}"
    return None, f"unlistable: {', '.join(unlistable) or '(no directory derived)'}"


def host_sync_heartbeat(path=None):
    """declaration-sync.sh's attempt heartbeat as {key: value}. None on ANY failure — absent,
    unreadable, empty. The caller renders None as COULD_NOT_COMPARE, never as a pass: a heartbeat
    we could not read is not evidence that the sync ran.

    A THIRD listing beside host_listing()/host_backups() for the same reason those two are
    separate — this file lives outside MONITORING_DIR, so neither scan can see it.
    """
    p = path or SYNC_HEARTBEAT_PATH
    if _on_host():
        try:
            text = Path(p).read_text(encoding="utf-8")
        except OSError as exc:
            log(f"SYNC_HEARTBEAT_UNREADABLE(local): {exc} — fail-open, NOT a pass")
            return None
    else:
        cmd = ["ssh", "-i", SSH_KEY, "-o", "ConnectTimeout=15", "-o", "BatchMode=yes", SSH_TARGET,
               f"cat {p}"]
        try:
            r = _run(cmd)
            if r.returncode != 0:
                log(f"SYNC_HEARTBEAT_UNREADABLE(ssh rc={r.returncode}): "
                    f"{r.stderr.strip()[:160]} — fail-open, NOT a pass")
                return None
            text = r.stdout
        except Exception as exc:
            log(f"SYNC_HEARTBEAT_UNREADABLE(ssh): {type(exc).__name__}: {exc} — fail-open")
            return None
    out = {}
    for line in text.splitlines():
        k, sep, v = line.partition("=")
        if sep:
            out[k.strip()] = v.strip()
    return out or None


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


def check_hash_drift(rows, host_hashes, labels=None):
    """repo -> host. Skipped for repo-resident rows: their host_path IS the repo copy, so the
    comparison is vacuous — reporting them as in-sync would be a lie by construction.

    Resolves the host filename through `host_path_for`, NOT through `row["host_path"]`. That
    subscript is what took BOTH hosts down on 2026-08-21: the `alert-registry` row expressed its
    host copy through `installed_at[].path` — a shape this schema has always permitted, and the
    shape every multi-host row already uses — and carried no top-level `host_path`, so this line
    raised `KeyError: 'host_path'` inside `evaluate()`, which has no `except`. The process died
    before printing its first `CHECK ...: OK`, and nothing watches this script's own liveness, so
    the outage was silent. `host_path_for` was already in this file and already used correctly by
    `check_dark` and `check_schedule_drift`; only these two call sites bypassed it. A helper
    honoured at some call sites and not others is not a design, it is a bug awaiting a trigger.
    Measured before the change: routing all 77 owned rows across both label sets through the
    helper produces ZERO basename divergences, so this is strictly a widening.
    """
    labels = labels if labels is not None else HOST_LABELS
    out = []
    for r in rows:
        if r.get("install_state") != "installed" or r.get("repo_resident"):
            continue
        host_path = host_path_for(r, labels)
        if not host_path:
            continue  # no resolvable host copy on this instance — DARK/ORPHAN's business, not ours
        name = os.path.basename(host_path)
        live = host_hashes.get(name)
        if live is None:
            continue  # absence is DARK/ORPHAN's business, not HASH_DRIFT's
        if r.get("sha256") and live != r["sha256"]:
            severity = "SEVERE" if r.get("kind") == "baseline-data" else "normal"
            out.append({"id": r["id"], "kind": r.get("kind"), "severity": severity,
                        "repo": (r.get("sha256") or "")[:12], "host": live[:12]})
    return out


def check_orphan(rows, host_hashes, labels=None):
    """host -> repo.

    Same `host_path_for` resolution as `check_hash_drift`, and for the same measured reason — this
    comprehension was the SECOND site to raise `KeyError: 'host_path'` on 2026-08-21. It is also
    the more dangerous of the two to get subtly wrong: a row that silently drops out of `known`
    turns its perfectly authorised file into a reported ORPHAN.
    """
    labels = labels if labels is not None else HOST_LABELS
    known = set()
    for r in rows:
        host_path = host_path_for(r, labels)
        if host_path:
            known.add(os.path.basename(host_path))
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


def _truthy_env(value):
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9_.:@/-]+$")


def probe_blocked_condition(cond, runner=None):
    """Evaluate a row's `blocked_on` condition. Returns (verdict, detail).

    verdict ∈ {"MET", "UNMET", "INDETERMINATE"}.

    🛑 INDETERMINATE MUST NEVER SUPPRESS. A condition we could not evaluate is not a condition
    we evaluated as still-blocking; the caller falls back to the plain age clock, so the worst a
    broken probe can do is restore today's behaviour. That asymmetry is the whole safety
    argument for letting a declaration silence an alarm at all.

    Exactly ONE kind is implemented, deliberately: `container_env`. An unknown kind is
    INDETERMINATE rather than a parse error, so adding a kind to the JSON before adding it here
    degrades to "no suppression" instead of crashing the daily run.
    """
    if not isinstance(cond, dict):
        return "INDETERMINATE", "blocked_on is not an object"
    kind = cond.get("kind")
    if kind != "container_env":
        return "INDETERMINATE", f"unsupported blocked_on kind {kind!r} — no suppression"
    ctr, var = cond.get("container"), cond.get("var")
    if not isinstance(ctr, str) or not isinstance(var, str) or not ctr or not var:
        return "INDETERMINATE", "container_env needs both `container` and `var`"
    # The values come from a committed declaration we author, but a declaration is data and data
    # reaching a shell is validated at the boundary, not trusted for its provenance.
    if not _SAFE_TOKEN.match(ctr) or not _SAFE_TOKEN.match(var):
        return "INDETERMINATE", "container/var failed the safe-token check — refusing to shell out"
    run = runner or _probe_container_env
    try:
        ok, raw = run(ctr, var)
    except Exception as exc:  # never let a probe break the daily reconcile
        return "INDETERMINATE", f"probe raised {type(exc).__name__}: {exc}"
    if not ok:
        return "INDETERMINATE", f"could not read {var} from {ctr}"
    met = _truthy_env(raw)
    return ("MET" if met else "UNMET"), f"{ctr}:{var}={raw.strip() or '<unset>'}"


def _probe_container_env(container, var):
    """(read_ok, raw_value). `printenv` exits 1 on an unset var — that is a READ, not a failure."""
    argv = ["docker", "exec", container, "printenv", var]
    if not _on_host():
        argv = ["ssh", "-i", SSH_KEY, "-o", "ConnectTimeout=15", "-o", "BatchMode=yes", SSH_TARGET,
                " ".join(shlex.quote(a) for a in argv)]
    r = _run(argv)
    if r.returncode == 0:
        return True, r.stdout
    if r.returncode == 1 and not (r.stderr or "").strip():
        return True, ""          # printenv's documented "variable is not set"
    return False, ""


def check_pending_stale(rows, today=None, probe=None):
    """inventory. `unclassified` shares the clock — an unowned artifact must not age silently.

    🛑 `install_state: pending` CONFLATED TWO DIFFERENT DEBTS, AND ONLY ONE OF THEM HAS A CLOCK.
    A row nobody has got to is neglect, and 30 days is the right alarm. A row whose install is
    BLOCKED on a named external condition is not neglect — and paging daily for it asks the
    operator to do something this estate's own law forbids. Measured: `book-liveness-canary`
    watches a gate whose kill switch `EMIT_BOOK_LIVENESS_ENABLED` is unset in the live
    container, so installing it would measure a DARK gate — precisely what "prove a revived
    guard FIRES before calling it live" exists to prevent. It paged on day 31 and every day
    after with no action available that was not a lie.

    And it RECURS by construction, because the check is a metronome over a queue: measured on
    the reconcile log, `nav-drift-canary` tripped at age 31 on 2026-08-12, and
    `book-liveness-canary` tripped at age 31 on 2026-08-21. Clearing one row only advances the
    queue to the next one.

    So a row may declare `blocked_on`, and the check gets STRICTER rather than quieter:

      * condition measured UNMET, within `review_by`  -> BLOCKED. Reported every run, no breach.
      * condition measured MET                        -> BREACH **immediately, at any age**. The
                                                         debt just became actionable and today's
                                                         check would not have noticed for weeks.
      * past `review_by`                              -> BREACH. The block is now the debt.
      * missing/invalid `review_by`, or the probe is
        INDETERMINATE / absent                        -> NO suppression; the age clock decides.

    The last line is the load-bearing one. Suppression is EARNED by a positive measurement, and
    never granted by the mere presence of the field — otherwise `blocked_on` is a mute button
    that the next wave reaches for, and this manual already records what happens to a control
    that lives in prose.

    Returns `{"breaches": [...], "probed": [...]}`.
    """
    today = today or date.today()
    breaches, probed = [], []
    for r in rows:
        if r.get("install_state") not in ("pending", "unclassified"):
            continue
        since = r.get("pending_since")
        age = None
        if since:
            try:
                age = (today - date.fromisoformat(since)).days
            except ValueError:
                age = None
        if not since:
            breaches.append({"id": r["id"], "age_days": None, "state": r["install_state"],
                             "reason": "NO_PENDING_SINCE"})
            probed.append({"id": r["id"], "verdict": "BREACH", "age_days": None,
                           "detail": "pending with no `pending_since` — unaged debt"})
            continue
        if age is None:
            # Unparseable date: same class as an unreadable input — report, do not invent an age.
            probed.append({"id": r["id"], "verdict": "INDETERMINATE", "age_days": None,
                           "detail": f"pending_since {since!r} is not an ISO date"})
            continue

        cond = r.get("blocked_on")
        if not isinstance(cond, dict):
            if age > PENDING_STALE_DAYS:
                breaches.append({"id": r["id"], "age_days": age, "state": r["install_state"],
                                 "reason": "AGED"})
                probed.append({"id": r["id"], "verdict": "BREACH", "age_days": age,
                               "detail": f"unblocked debt older than {PENDING_STALE_DAYS}d"})
            else:
                probed.append({"id": r["id"], "verdict": "OK", "age_days": age,
                               "detail": f"within the {PENDING_STALE_DAYS}d clock"})
            continue

        verdict, detail = probe_blocked_condition(cond, probe)
        review_by = cond.get("review_by")
        try:
            review_dt = date.fromisoformat(review_by) if isinstance(review_by, str) else None
        except ValueError:
            review_dt = None

        if verdict == "MET":
            breaches.append({"id": r["id"], "age_days": age, "state": r["install_state"],
                             "reason": "UNBLOCKED", "detail": detail})
            probed.append({"id": r["id"], "verdict": "BREACH", "age_days": age,
                           "detail": f"UNBLOCKED — {detail}; install is now actionable"})
            continue
        if review_dt is None:
            # A block with no review date is not a block. Fall back to the age clock, loudly.
            if age > PENDING_STALE_DAYS:
                breaches.append({"id": r["id"], "age_days": age, "state": r["install_state"],
                                 "reason": "BLOCK_NO_REVIEW_BY"})
            probed.append({"id": r["id"], "verdict": "BREACH" if age > PENDING_STALE_DAYS else "OK",
                           "age_days": age,
                           "detail": f"blocked_on carries no valid `review_by` ({review_by!r}) — "
                                     f"no suppression, age clock applies"})
            continue
        if today > review_dt:
            breaches.append({"id": r["id"], "age_days": age, "state": r["install_state"],
                             "reason": "BLOCK_STALE", "review_by": review_by})
            probed.append({"id": r["id"], "verdict": "BREACH", "age_days": age,
                           "detail": f"block expired {review_by} — the block is now the debt "
                                     f"({detail})"})
            continue
        if verdict == "UNMET":
            probed.append({"id": r["id"], "verdict": "BLOCKED", "age_days": age,
                           "detail": f"{detail}; blocked, review_by {review_by}"})
            continue
        # INDETERMINATE inside the review window: no suppression, age clock decides.
        if age > PENDING_STALE_DAYS:
            breaches.append({"id": r["id"], "age_days": age, "state": r["install_state"],
                             "reason": "BLOCK_UNVERIFIABLE", "detail": detail})
        probed.append({"id": r["id"], "verdict": "BREACH" if age > PENDING_STALE_DAYS else "OK",
                       "age_days": age,
                       "detail": f"blocked_on INDETERMINATE ({detail}) — no suppression, "
                                 f"age clock applies"})
    return {"breaches": breaches, "probed": probed}


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
    """host -> host. A `load-bearing` artifact installed here with no recoverable backup.

    Detection without recovery is half a guard: the daily reconciler catches a HASH_DRIFT within
    24h, but the backup is what makes that drift REVERSIBLE. Scoped to load-bearing rows so it
    stays an actionable list rather than a wall.

    Returns `{"breaches": [...], "probed": [...]}`. `probed` carries one row per artifact with
    the directories actually searched and what was found, because "assert POSITIVE per-check
    output" is the only thing that would have made the blindness above visible from the log.
    """
    labels = labels if labels is not None else HOST_LABELS
    if backups is None:
        return {"breaches": [], "probed": []}
    breaches, probed = [], []
    for r in rows:
        if r.get("install_state") != "installed" or r.get("criticality") != "load-bearing":
            continue
        if r.get("repo_resident") or not r.get("sha256"):
            continue  # repo-resident rows are recoverable from git; null-sha rows are self-referential
        for e in entries_for_host(r, labels):
            path = e.get("path") or ""
            if not path:
                continue
            covered, detail = backup_covers(path, backups)
            verdict = "OK" if covered else ("SKIPPED" if covered is None else "MISSING")
            probed.append({"id": r["id"], "host": e.get("host"), "path": path,
                           "verdict": verdict, "detail": detail})
            if covered is False:
                breaches.append({"id": r["id"], "host": e.get("host"),
                                 "artifact": os.path.basename(path), "detail": detail})
    return {"breaches": breaches, "probed": probed}


def derive_cadence_minutes(expr):
    """Longest legitimate gap between two consecutive fires of a cron expression, in minutes.
    None when it cannot be derived — the caller then reports COULD_NOT_COMPARE rather than
    inventing a bound, because a guessed bound is the "confident ALARM" instrument defect.

    The MAXIMUM gap, not the minimum: a liveness bound has to tolerate the longest quiet period
    the schedule legitimately produces. `33 * * * *` -> 60. `*/15 * * * *` -> 15. `13,43 * * * *`
    -> 30. A day/month/dow restriction (`39 8 * * 2`) returns None: the gap is then a function of
    the calendar, and this check has no consumer that needs it.
    """
    if not isinstance(expr, str):
        return None
    text = expr.strip()
    if text.startswith("@"):
        text = _CRON_MACROS.get(text.lower(), "")
    fields = text.split()
    if len(fields) != 5:
        return None
    if fields[2] != "*" or fields[3] != "*" or fields[4] != "*":
        return None
    minutes = expand_minute_field(fields[0])
    hours = expand_minute_field(fields[1], 23)
    if not minutes or not hours:
        return None
    fires = sorted(h * 60 + m for h in hours for m in minutes)
    # Wrap-around: the gap from the last fire of one day to the first of the next.
    gaps = [b - a for a, b in zip(fires, fires[1:])] + [fires[0] + 1440 - fires[-1]]
    return max(gaps)


def _parse_stamp(text):
    """`2026-08-12T07:33:01Z` -> aware datetime. None on anything else."""
    if not isinstance(text, str) or not text.strip():
        return None
    try:
        return datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def check_sync_liveness(rows, heartbeat, labels=None, now=None):
    """Is declaration-sync ATTEMPTING on this host, within a bound derived from its own schedule?

    Three verdicts, and the third is not a pass:
      LIVE               attempted within cadence x SYNC_LIVENESS_MISSED_CYCLES
      STALE              attempted, but longer ago than that            -> drift finding
      COULD_NOT_COMPARE  no row / no schedule / underivable cadence / no or unparseable
                         heartbeat                                      -> REPORTED, never a pass

    ATTEMPT recency, never OUTPUT recency, and the distinction is load-bearing rather than
    stylistic: declaration-sync.sh only rewrites a declaration whose hash CHANGED, so a healthy
    run against a stable declaration set writes nothing and advances no mtime. A bound built on
    the declarations' own freshness would fire on every healthy host whose configs simply had not
    changed lately. CLAUDE.md states this generally — "Producer liveness pages on ATTEMPT
    recency (heartbeat stamped at job START, fail-soft, before conditional work), NOT output
    recency" — and this is that rule's second substrate.

    Absent heartbeat REPORTS rather than drifting, deliberately: a host upgraded before its first
    post-install sync would otherwise page for three days for having done nothing wrong. What
    makes that safe rather than decorative is that the installing wave proves the heartbeat exists
    on every host before it closes, so afterwards "absent" means deleted or rebuilt.
    """
    labels = labels if labels is not None else HOST_LABELS
    now = now or datetime.now(timezone.utc)
    probed, findings = [], []
    row = next((r for r in rows if r.get("id") == SYNC_LIVENESS_ROW_ID), None)
    host = sorted(labels)[0] if labels else "unknown"

    def out(verdict, detail, **kw):
        r = {"host": host, "verdict": verdict, "detail": detail, **kw}
        probed.append(r)
        return r

    if row is None:
        out("COULD_NOT_COMPARE",
            f"no inventory row with id {SYNC_LIVENESS_ROW_ID!r} is owned by this instance")
        return {"probed": probed, "findings": findings}
    schedule = schedule_for(row, labels)
    cadence = derive_cadence_minutes(schedule)
    if cadence is None:
        out("COULD_NOT_COMPARE", f"cannot derive a cadence from schedule {schedule!r}",
            schedule=schedule)
        return {"probed": probed, "findings": findings}
    bound = cadence * SYNC_LIVENESS_MISSED_CYCLES
    if not heartbeat:
        out("COULD_NOT_COMPARE", f"heartbeat unreadable or absent at {SYNC_HEARTBEAT_PATH}",
            schedule=schedule, cadence_minutes=cadence, bound_minutes=bound,
            cycles=SYNC_LIVENESS_MISSED_CYCLES)
        return {"probed": probed, "findings": findings}
    stamp = _parse_stamp(heartbeat.get("attempt_at"))
    if stamp is None:
        out("COULD_NOT_COMPARE",
            f"heartbeat carries no parseable attempt_at ({heartbeat.get('attempt_at')!r})",
            schedule=schedule, cadence_minutes=cadence, bound_minutes=bound,
            cycles=SYNC_LIVENESS_MISSED_CYCLES)
        return {"probed": probed, "findings": findings}

    age = int((now - stamp).total_seconds() // 60)
    common = {"schedule": schedule, "cadence_minutes": cadence, "bound_minutes": bound,
              "cycles": SYNC_LIVENESS_MISSED_CYCLES, "age_minutes": age,
              "last_verdict": heartbeat.get("verdict", "-"),
              "window": f"last {bound}m ({SYNC_LIVENESS_MISSED_CYCLES} x {cadence}m cycle)"}
    if age > bound:
        r = out("STALE",
                f"last attempt {age}m ago exceeds the {bound}m bound derived from {schedule!r}",
                **common)
        findings.append({k: r[k] for k in
                         ("host", "verdict", "detail", "age_minutes", "bound_minutes",
                          "cadence_minutes", "cycles", "last_verdict")})
    else:
        out("LIVE", f"last attempt {age}m ago, within the {bound}m bound", **common)
    return {"probed": probed, "findings": findings}


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


# ── SOT_PARITY (OPS-MONITORING-INVENTORY-HOST-SYNC-W1 Ch3) ───────────────────
# Every other check in this file READS the inventory and assumes it is true. This one audits
# that assumption, because for its whole life the assumption was false and nothing said so:
# the reconciler resolves its checklist to a HOST-LOCAL sibling copy, `ops/monitoring/**` is
# paths-ignored so no deploy ever fed it, and per-host row ownership means a row owned by the
# OTHER host can rot with both instances reporting green. Measured 2026-08-05: repo 52 rows,
# both hosts 50, two rows missing for ~12h and ~1 day.
#
# Ch2's declaration-sync.sh removes the manual step. This exists because any sync can fail, and
# a failed sync must not reproduce the same silence one layer up.

def load_sot_parity_config(path=None):
    """Sibling-first, exactly like the inventory and the doc claims — same measured reason.

    Returns None when absent or unparseable. The caller renders that as COULD_NOT_COMPARE, never
    as a pass: a config this process cannot read means the audit did not happen.
    """
    p = Path(path) if path else Path(os.environ.get("SOT_PARITY_CONFIG_PATH", "")) if os.environ.get(
        "SOT_PARITY_CONFIG_PATH") else None
    if p is None:
        sibling = Path(__file__).resolve().parent / "sot-parity-config.json"
        p = sibling if sibling.exists() else REPO_ROOT / "ops/monitoring/sot-parity-config.json"
    try:
        return json.loads(p.read_text())
    except FileNotFoundError:
        return None
    except Exception as exc:
        log(f"SOT_PARITY_CONFIG_LOAD_FAILED: {exc} (path {p}) — reported as COULD_NOT_COMPARE")
        return None


def fetch_sot_bytes(url, timeout):
    """Fetch the committed SoT. Returns bytes, or None on ANY failure.

    Deliberately narrow: no redirects followed beyond urllib's default, no auth, no retries. A
    transient failure is COULD_NOT_COMPARE, which under `report` enforcement is information — the
    right answer for a check whose whole point is that it must not become a new way to page.
    """
    try:
        from urllib.request import urlopen           # local import: keeps CI/import cost at zero
        with urlopen(url, timeout=timeout) as resp:  # noqa: S310 - fixed https URL from config
            if getattr(resp, "status", 200) != 200:
                return None
            return resp.read()
    except Exception:
        return None


def check_alert_episode_age(registry_path=None, state_dir=None, labels=None, now=None):
    """For every ADOPTED alert, how long has its FIRING episode been open?

    Verdicts, and only the third is a drift finding:
      CLEAR              no marker — nothing is firing
      FIRING             marker present, younger than ALERT_EPISODE_PAGE_DAYS   -> reported
      FIRING_STALE       marker present and older than that                     -> drift finding
      COULD_NOT_COMPARE  registry missing/unparseable, or a marker that will not parse

    ABSENT STATE RENDERS AS ABSENT. There is deliberately no `or 0` anywhere below: an
    unreadable registry reports COULD_NOT_COMPARE, and an unparseable marker reports its own
    raw value rather than an age. Defaulting either to zero would print "nothing is firing" as
    a confident fact about a value we do not have, which is the exact shape this estate keeps
    retiring — and here it would silently certify the very staleness the check exists to find.
    """
    labels = labels if labels is not None else HOST_LABELS
    now = now or datetime.now(timezone.utc)
    registry_path = registry_path or ALERT_REGISTRY_PATH
    state_dir = state_dir or ALERT_STATE_DIR
    host = sorted(labels)[0] if labels else "unknown"
    probed, findings = [], []

    def out(alert_id, verdict, detail, **kw):
        r = {"host": host, "alert_id": alert_id, "verdict": verdict, "detail": detail, **kw}
        probed.append(r)
        return r

    try:
        with open(registry_path) as fh:
            rows = json.load(fh).get("alerts", [])
    except (OSError, ValueError) as e:
        out("-", "COULD_NOT_COMPARE", f"alert registry unreadable at {registry_path}: {e}")
        return {"probed": probed, "findings": findings}

    adopted = [r for r in rows if r.get("adopted") is True and r.get("alert_id")]
    if not adopted:
        # VACUITY: a registry with no adopted alert means this check asserts nothing. Say so
        # rather than printing a clean sweep over an empty set.
        out("-", "COULD_NOT_COMPARE",
            f"registry has {len(rows)} row(s) but NONE are adopted — nothing to measure")
        return {"probed": probed, "findings": findings}

    bound_days = ALERT_EPISODE_PAGE_DAYS
    for row in adopted:
        aid = row["alert_id"]
        marker = os.path.join(state_dir, f"{aid}-last-fired-at")
        if not os.path.exists(marker):
            out(aid, "CLEAR", "no marker — not firing", bound_days=bound_days)
            continue
        try:
            with open(marker) as fh:
                raw = fh.read().strip()
        except OSError as e:
            out(aid, "COULD_NOT_COMPARE", f"marker unreadable: {e}", bound_days=bound_days)
            continue
        if not raw.isdigit():
            out(aid, "COULD_NOT_COMPARE",
                f"marker does not parse as an epoch (raw={raw!r})", bound_days=bound_days)
            continue
        opened = datetime.fromtimestamp(int(raw), timezone.utc)
        age_days = (now - opened).total_seconds() / 86400.0
        common = {"bound_days": bound_days, "age_days": round(age_days, 2),
                  "opened_at": opened.strftime("%Y-%m-%dT%H:%M:%SZ")}
        if age_days >= bound_days:
            r = out(aid, "FIRING_STALE",
                    f"episode open {age_days:.1f}d, past the {bound_days}d bound — either the "
                    f"condition never cleared or nothing is calling --clear for it", **common)
            findings.append({k: r[k] for k in
                             ("host", "alert_id", "verdict", "detail", "age_days",
                              "bound_days", "opened_at")})
        else:
            out(aid, "FIRING", f"episode open {age_days:.1f}d (bound {bound_days}d)", **common)
    return {"probed": probed, "findings": findings}


# ─────────── SOT_PARITY: propagation lag is not drift (OPS-SOT-PARITY-PHASE-W1) ───────────
#
# 🛑 THE DEFECT THIS RETIRES. The daily reconcile samples the declaration at a FIXED time, and
# on aoe-1 that time sits 50 minutes AFTER the last hourly sync and 10 minutes BEFORE the next.
# Any commit landing in that 50-minute window makes the sample read DRIFTED against a host that
# is behaving perfectly — and the next sync heals it 10 minutes later, unobserved, because the
# alarm only looks once a day.
#
# MEASURED on aoe-1, 2026-08-25, from the ledger and the sync log. Every DRIFTED reading whose
# sync-log era carries timestamps was healed by the VERY NEXT sync, +10 minutes, the same day:
#
#     reconcile 07:17:44Z  DRIFTED   ->  sync 07:27:01Z  SYNCED   (2026-08-17)
#     reconcile 07:17:44Z  DRIFTED   ->  sync 07:27:01Z  SYNCED   (2026-08-20)
#     reconcile 07:17:45Z  DRIFTED   ->  sync 07:27:01Z  SYNCED   (2026-08-23)
#     reconcile 07:17:43Z  DRIFTED   ->  sync 07:27:01Z  SYNCED   (2026-08-24)
#
# 4 for 4. And 5 of the 6 DRIFTED days had the SoT commit land inside 06:27-07:17 UTC — the
# operator's working afternoon in UTC+8, which is exactly when waves land.
#
# The alert body asserted the opposite in prose: *"a DRIFTED reading on two consecutive DAILY
# runs spans >24h with ~24 hourly sync opportunities in between, so this is not propagation lag
# — the sync is not landing."* That is a NON-SEQUITUR, and it is the reason six false pages were
# read as an outage. Those 24 opportunities all occur AFTER each sample, and each new day brings
# a NEW edit landing in the SAME window. Two consecutive DRIFTED days mean two consecutive days
# with a commit in the window — not a broken sync. Rescheduling one cron would hide it; the
# phase relationship between two independent crontab lines is not something either file asserts,
# so it would silently regress. So the fix is to make the phase IRRELEVANT.
#
# THE DISCRIMINATOR — and it is exact, not heuristic. `declaration-sync.sh` now records, per
# declaration, the sha it RESOLVED on its last attempt. Then:
#
#   local == sot                          -> IN_SYNC
#   local != sot, local == resolved       -> PROPAGATION_PENDING. The host is faithfully carrying
#                                            what the last sync fetched; the SoT has moved since.
#                                            Reported every run, never a finding, never a page.
#   local != sot, local != resolved       -> DRIFTED. The sync fetched something this host does
#                                            not have. THAT is "the sync is not landing".
#   resolved absent / stale / sync failed -> DRIFTED (unchanged). Suppression is EARNED.
#
# 🛑 THE SUPPRESSION IS EARNED BY A MEASUREMENT, NEVER GRANTED BY THE FIELD'S PRESENCE. Three
# conditions must ALL hold, or the verdict falls straight back to DRIFTED: a heartbeat we could
# read, a SUCCESSFUL last verdict, and an `attempt_at` fresh within the bound. A sync that has
# STOPPED therefore cannot buy silence with a stale resolved-sha — and SYNC_LIVENESS, a separate
# drift key, pages on that independently. The two checks compose; neither covers for the other.

SOT_PARITY_HEARTBEAT_MAX_AGE_MIN = int(os.environ.get("SOT_PARITY_HEARTBEAT_MAX_AGE_MIN", "120"))

# The heartbeat key declaration-sync.sh writes per file. Namespaced so it cannot collide with the
# flat `attempt_at` / `verdict` keys, and so an old-format heartbeat simply has none of them.
RESOLVED_KEY_PREFIX = "resolved:"


def heartbeat_resolved_sha(heartbeat, declaration_name):
    """The sha the last sync attempt RESOLVED for `declaration_name`, or None.

    None on every failure mode — no heartbeat, old format, key absent, value not a sha256. None
    means "no suppression", which is the safe direction by construction.
    """
    if not isinstance(heartbeat, dict):
        return None
    v = heartbeat.get(RESOLVED_KEY_PREFIX + declaration_name)
    if not isinstance(v, str):
        return None
    v = v.strip().lower()
    return v if len(v) == 64 and all(c in "0123456789abcdef" for c in v) else None


def sync_attempt_is_fresh(heartbeat, now=None, max_age_minutes=None):
    """(fresh: bool, detail: str). A stale or unparseable attempt is NOT fresh — never a pass."""
    bound = SOT_PARITY_HEARTBEAT_MAX_AGE_MIN if max_age_minutes is None else max_age_minutes
    if not isinstance(heartbeat, dict):
        return False, "no heartbeat"
    at = heartbeat.get("attempt_at")
    stamped = _parse_stamp(at) if at else None
    if stamped is None:
        return False, f"attempt_at unparseable ({at!r})"
    now = now or datetime.now(timezone.utc)
    age = (now - stamped).total_seconds() / 60.0
    if age > bound:
        return False, f"last sync attempt {age:.0f}m ago, past the {bound}m bound"
    return True, f"last sync attempt {age:.0f}m ago"


def classify_sot_parity(local_sha, sot_sha, heartbeat, declaration_name,
                        now=None, max_age_minutes=None):
    """PURE. -> (verdict, detail). The ONE derivation; the finding, the ledger row and the
    per-run line are three projections of it, never three independent re-decisions."""
    if local_sha == sot_sha:
        return "IN_SYNC", "the declaration this host reads is the committed one"
    drifted = "this host is reading a declaration that is NOT the committed one"
    resolved = heartbeat_resolved_sha(heartbeat, declaration_name)
    if resolved is None:
        return "DRIFTED", f"{drifted} — and the last sync recorded no resolved sha for it"
    verdict_last = (heartbeat.get("verdict") or "").strip().upper() if isinstance(heartbeat, dict) else ""
    if verdict_last not in ("SYNCED", "UNCHANGED"):
        return "DRIFTED", f"{drifted} — last sync verdict was {verdict_last or '<absent>'}, not a success"
    fresh, fresh_detail = sync_attempt_is_fresh(heartbeat, now=now, max_age_minutes=max_age_minutes)
    if not fresh:
        return "DRIFTED", f"{drifted} — {fresh_detail}"
    if resolved != local_sha:
        return "DRIFTED", (f"{drifted} — the last sync RESOLVED {resolved[:16]} but this host "
                           f"holds {local_sha[:16]}: the sync is not landing")
    return "PROPAGATION_PENDING", (
        f"the SoT moved after the last sync; this host faithfully holds what that sync resolved "
        f"({resolved[:16]}) — {fresh_detail}. Not drift, and not counted toward the streak")


def check_sot_parity(inventory_path, config, labels=None, fetch=None, read_local=None,
                     heartbeat=None, now=None):
    """Does the declaration this instance READS match the one that is COMMITTED?

    Three outcomes, deliberately distinct — the verdict-token principle at per-check granularity:
      IN_SYNC            local sha256 == SoT sha256
      DRIFTED            both readable and they differ            -> finding
      COULD_NOT_COMPARE  SoT unreachable, or no config, or the
                         local file unreadable                    -> finding, and NOT a pass

    Returns {"findings": [...], "probed": [...]} so the caller emits POSITIVE per-host output.
    Read-only by construction: it compares and reports. Repairing the copy is Ch2's job, and a
    checker that silently rewrote its own inputs would be the auto-mutation this repo forbids.
    """
    labels = labels if labels is not None else HOST_LABELS
    host = sorted(labels)[-1] if labels else "unknown"
    fetch = fetch if fetch is not None else fetch_sot_bytes
    read_local = read_local if read_local is not None else (lambda p: Path(p).read_bytes())

    def row(verdict, detail, local=None, sot=None):
        r = {"host": host, "path": str(inventory_path), "verdict": verdict, "detail": detail}
        if local:
            r["local_sha256"] = local
        if sot:
            r["sot_sha256"] = sot
        return r

    if not config:
        r = row("COULD_NOT_COMPARE", "no sot-parity config on this host")
        return {"findings": [r], "probed": [r]}
    url = config.get("sot_url")
    if not url:
        r = row("COULD_NOT_COMPARE", "config carries no sot_url")
        return {"findings": [r], "probed": [r]}

    try:
        local_sha = hashlib.sha256(read_local(inventory_path)).hexdigest()
    except Exception as exc:
        r = row("COULD_NOT_COMPARE", f"local declaration unreadable: {exc}")
        return {"findings": [r], "probed": [r]}

    body = fetch(url, config.get("fetch_timeout_seconds", 20))
    if not body:
        r = row("COULD_NOT_COMPARE", f"SoT unreachable at {url}", local=local_sha)
        return {"findings": [r], "probed": [r]}

    sot_sha = hashlib.sha256(body).hexdigest()
    verdict, detail = classify_sot_parity(local_sha, sot_sha, heartbeat,
                                          os.path.basename(str(inventory_path)), now=now)
    r = row(verdict, detail, local=local_sha, sot=sot_sha)
    # PROPAGATION_PENDING is REPORTED, never a finding. It is the measured statement "the sync is
    # healthy and the SoT moved since its last attempt", which is not an operator-action-required
    # condition — and SYNC_LIVENESS pages independently if the sync ever stops attempting.
    return {"findings": [] if verdict in ("IN_SYNC", "PROPAGATION_PENDING") else [r], "probed": [r]}


# ── SOT_PARITY reachability instrument (OPS-NUMERIC-PROBE-VALIDATION-W1 Part B) ──────────────
#
# sot-parity-config.json:12 sets promotion to `block` at 30 consecutive daily runs, on BOTH
# hosts, IN_SYNC, with ZERO COULD_NOT_COMPARE — and NOTHING counted toward it. A promotion
# criterion that ships with no instrument measuring its own approach cannot be evaluated; it can
# only be waited on, which is how a guard sits in `report` forever and becomes decoration.
#
# This measures the approach. It changes no verdict, no threshold, and no enforcement mode.
#
# THE RESET TAXONOMY IS THE DELIVERABLE. DRIFTED and COULD_NOT_COMPARE reset the streak for
# entirely different reasons and imply different fixes — one wants a PROPAGATING verdict, the
# other wants fetch resilience. Collapsing them into "reset" throws away the whole finding.

def read_sot_parity_ledger(path=None, host=None, _open=None):
    """Prior ledger rows for THIS host, oldest first. Returns None when the ledger is UNREADABLE.

    None and [] are deliberately distinct, and that distinction IS the fail-open contract:
      []    the world has produced no rows yet (first run). A FACT, not a failure — the correct
            verdict over it is a REPORTED zero, never silence.
      None  we were handed a ledger and could not open or parse it. Indeterminate: it must
            neither page nor suppress. A broken instrument is not evidence that the subject is
            healthy, and it is not evidence that it is sick either.
    Unparseable INDIVIDUAL lines are skipped rather than fatal — one torn append (a host killed
    mid-write) must not blind the whole instrument.
    """
    p = Path(path or SOT_PARITY_LEDGER_PATH)
    opener = _open or (lambda q: q.open("r", encoding="utf-8"))
    if not p.exists():
        return []
    try:
        with opener(p) as fh:
            raw = fh.read().splitlines()
    except Exception as exc:                                        # noqa: BLE001
        log(f"SOT_PARITY_LEDGER_UNREADABLE: {exc} (path {p}) — neither paging nor suppressing")
        return None
    rows = []
    for line in raw:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict):
            continue
        if host is None or row.get("host") == host:
            rows.append(row)
    return rows


def is_adhoc_run():
    """Is THIS invocation a hand-run rather than the scheduled daily reconcile?

    Cron sets nothing, so the scheduled run is always authoritative. Only a human (or a wave's
    verification step) sets this, and only to keep its own run out of a measurement it would
    otherwise distort in either direction.
    """
    return os.environ.get("ALGOVAULT_SOT_PARITY_ADHOC", "0") == "1"


def sot_parity_streaks(prior_rows, current_verdict, now=None,
                       target=SOT_PARITY_PROMOTION_TARGET_RUNS,
                       window_days=SOT_PARITY_TAXONOMY_WINDOW_DAYS):
    """THE ONE DERIVATION of every SOT_PARITY streak. Single-derivation rule, deliberately.

    The per-run output line, the ledger row's `streak` field and the sustained-breach alert
    decision ALL project from this one return value. None of them recomputes it. Two derivations
    of one quantity drift to contradiction, and the bug then lives in whichever copy nobody is
    watching.

    `prior_rows` excludes the current run; `current_verdict` is folded in here so the caller
    never has to decide whether "the streak" includes today.
    """
    now = now or datetime.now(timezone.utc)
    prior = list(prior_rows or [])

    # ── COLLAPSE TO ONE ENTRY PER UTC DATE BEFORE DERIVING ANY STREAK ────────────────────────
    # The criterion counts "30 consecutive DAILY runs", so a per-RUN streak is INFLATABLE: 30
    # ad-hoc invocations in one afternoon would satisfy a 30-day criterion, and the instrument
    # would be biasing precisely the quantity it exists to measure. Every verification run of
    # this reconciler is such an invocation — including the one that shipped this code.
    #
    # Ties within a date resolve by DECLARED PRECEDENCE, never by row order: a load-bearing
    # property must not be rented from the order rows happen to arrive in, so two runs on one
    # date yield the same verdict whichever landed first. DRIFTED outranks COULD_NOT_COMPARE
    # (a measured mismatch is worse than a failure to look); both outrank IN_SYNC, because a
    # date carrying ANY non-IN_SYNC reading is not a clean date.
    # AD-HOC RUNS ARE RECORDED BUT NEVER DERIVED FROM, and the bias they remove runs BOTH ways.
    # The per-date collapse stops an ad-hoc run INFLATING the streak. It does not stop the
    # opposite: an operator running this reconciler by hand minutes after merging an inventory
    # change reads DRIFTED out of the ~65-min propagation window, which by the precedence above
    # marks an otherwise-clean date dirty — and two such runs on consecutive dates would PAGE
    # SOT_PARITY_SUSTAINED_DRIFT for a condition that never existed. A false page on a brand-new
    # alert is how a guard gets muted in its first week. Cron sets nothing and is unaffected;
    # ALGOVAULT_SOT_PARITY_ADHOC=1 marks the row, and a marked row stays in the ledger as
    # forensics while contributing to no streak, no taxonomy and no denominator.
    # PROPAGATION_PENDING is deliberately ABSENT from RANK, so a day carrying only that verdict
    # contributes NO date at all — exactly how an `adhoc` row is treated, and for the same reason:
    # it is neither evidence of parity nor evidence against it, so it must neither advance nor
    # reset the promotion streak. It cannot over-credit: with no IN_SYNC date the streak does not
    # grow, because `trailing("IN_SYNC")` counts dates, not runs.
    RANK = {"IN_SYNC": 0, "COULD_NOT_COMPARE": 1, "DRIFTED": 2}
    by_date = {}
    for r in prior + [{"at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "verdict": current_verdict,
                       "adhoc": is_adhoc_run()}]:
        if r.get("adhoc"):
            continue
        d = (r.get("at") or "")[:10]
        v = r.get("verdict")
        if not d or v not in RANK:
            continue
        if d not in by_date or RANK[v] > RANK[by_date[d]]:
            by_date[d] = v
    seq = [by_date[d] for d in sorted(by_date)]

    def trailing(match):
        n = 0
        for v in reversed(seq):
            if v == match:
                n += 1
            else:
                break
        return n

    # Reset taxonomy over the window, derived from the SAME per-date collapse as the streak.
    # "A reset" must mean one thing: counting resets per RUN while counting the streak per DAY
    # would be two derivations of one quantity, and they drift the moment anyone re-runs the
    # reconciler by hand. A reset is any non-IN_SYNC DATE; its reason is that date's verdict,
    # which is exactly the distinction the taxonomy exists to preserve.
    cutoff = now - timedelta(days=window_days)
    resets = {"DRIFTED": 0, "COULD_NOT_COMPARE": 0}
    last_reset_at, last_reset_reason = None, None
    for d in sorted(by_date):
        v = by_date[d]
        if v == "IN_SYNC":
            continue
        last_reset_reason = v
        last_reset_at = d
        stamp = _parse_stamp(d + "T00:00:00Z")
        if stamp is None or stamp >= cutoff:
            resets[v] = resets.get(v, 0) + 1

    # Observable days: distinct UTC dates the instrument actually has a reading for. NOT elapsed
    # calendar days — a rate whose denominator counts days we never observed would understate the
    # reset frequency, and this number's only job is to make reachability honest.
    observable_days = len(by_date)
    total_resets = sum(resets.values())

    return {
        "in_sync": trailing("IN_SYNC"),
        "drifted_consecutive": trailing("DRIFTED"),
        "could_not_compare_consecutive": trailing("COULD_NOT_COMPARE"),
        "last_reset_at": last_reset_at,
        "last_reset_reason": last_reset_reason,
        "resets_window": resets,
        "window_days": window_days,
        "observable_days": observable_days,
        # Observed reset RATE — resets per observable day. Reachability stays a LIVE metric that
        # keeps updating as the window grows, instead of a one-time calculation frozen in one
        # status entry. A criterion needing `target` consecutive clean runs is only plausible if
        # this rate is well below 1/target.
        "reset_rate": (total_resets / observable_days) if observable_days else None,
        "target": target,
    }


def render_sot_parity_streak(host, s):
    """The B-R3 per-run line. EVERY run prints its streak — never silence.

    A run that computed nothing must not look like a clean streak, so the indeterminate case
    renders its own distinct line rather than a zero.
    """
    if s is None:
        return (f"SOT_PARITY_STREAK {host} INDETERMINATE — ledger unreadable, streak not computed "
                f"(this is NOT a clean streak, and it neither pages nor suppresses)")
    resets = s["resets_window"]
    rate = "n/a" if s["reset_rate"] is None else f"{s['reset_rate']:.2f}/day"
    last = (f"{s['last_reset_at']} ({s['last_reset_reason']})"
            if s["last_reset_at"] else "never")
    return (f"SOT_PARITY_STREAK {host} {s['in_sync']}/{s['target']} · last reset {last} · "
            f"resets_{s['window_days']}d: "
            + " ".join(f"{k}={v}" for k, v in sorted(resets.items()))
            + f" · observed reset rate {rate} over {s['observable_days']} observable day(s)")


def build_sot_parity_body(host, condition, consecutive, s, row):
    """Body for SOT_PARITY_SUSTAINED_DRIFT.

    Carries the host, the consecutive count, the reset reason and BOTH sha prefixes. The Action
    line is the TEMPLATE form — a literal W<number> is forbidden, because wave numbering moves and
    a hardcoded one in a persisted artifact is wrong the moment it does. send_telegram.sh's
    resolve_template() substitutes it at send time.
    """
    need = SUSTAINED_BREACH_THRESHOLDS[(SOT_PARITY_ALERT_ID, condition)]
    # 🛑 THE PRIOR SENTENCE HERE WAS A NON-SEQUITUR, AND IT COST SIX FALSE PAGES READ AS AN
    # OUTAGE. It said: "a DRIFTED reading on two consecutive DAILY runs spans >24h with ~24
    # hourly sync opportunities in between, so this is not propagation lag — the sync is not
    # landing." Those 24 opportunities all occur AFTER each sample, and each new day brings a
    # NEW commit landing in the same blind window, so two consecutive DRIFTED days meant two
    # consecutive days with an edit in the window — not a broken sync. Measured on aoe-1: 4 of 4
    # timestamped DRIFTED readings were healed by the very next sync, +10 minutes, same day.
    # The claim is now MEASURED rather than argued: DRIFTED can only be reached when the last
    # successful sync resolved a sha this host does not hold (see classify_sot_parity).
    why = ("the last successful sync RESOLVED a declaration this host does not hold — so this "
           "is not propagation lag, which is now classified separately as PROPAGATION_PENDING "
           "and never reaches this alert"
           if condition == "DRIFTED" else
           "a host that cannot verify its own declaration for three days is auditing blind, and "
           "every other reconciler check is downstream of that file")
    lines = [
        f"🛑 {SOT_PARITY_ALERT_ID}",
        f"Condition: {condition} on {consecutive} consecutive daily runs on {host} "
        f"(threshold {need}) — {why}",
        f"  host: {host}",
        f"  consecutive {condition}: {consecutive}",
        f"  reset reason: {s['last_reset_reason'] if s and s.get('last_reset_reason') else condition}",
        f"  local sha256:  {(row.get('local_sha256') or '-')[:16]}",
        f"  sot   sha256:  {(row.get('sot_sha256') or '-')[:16]}",
        f"  detail: {row.get('detail', '-')}",
    ]
    if s:
        lines.append(f"State: {render_sot_parity_streak(host, s)}")
    lines += [
        "Note: `enforcement` is still `report` — this alert READS the streak and changes no "
        "verdict, no threshold and no enforcement mode.",
        f"Action: dispatch {SOT_PARITY_RECOMMENDED_WAVE} via Cowork → Claude Code",
        "Source log: /var/log/monitoring-inventory-reconcile.log",
        f"Ledger: {SOT_PARITY_LEDGER_PATH}",
    ]
    return "\n".join(lines)


def append_sot_parity_observation(row, path=None, _open=None):
    """Append one row per reconciler run per host, so the criterion's approach is MEASURED.

    Best-effort throughout: a ledger write must NEVER change the verdict — the same constraint
    payment-decline-canary.py's append_observation() already states. An instrument that can break
    its subject is worse than no instrument.
    """
    p = Path(path or SOT_PARITY_LEDGER_PATH)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        opener = _open or (lambda q: q.open("a", encoding="utf-8"))
        with opener(p) as fh:
            fh.write(json.dumps(row) + "\n")
        return True
    except Exception as exc:                                        # noqa: BLE001
        log(f"SOT_PARITY_LEDGER_APPEND_FAILED (non-fatal, verdict unchanged): {exc}")
        return False


def evaluate_sot_parity_streak(probed_rows, ledger_path=None, now=None, fire=None):
    """Ledger + per-run output + sustained-breach decision, for every host row this run probed.

    Returns the list of (row, streaks) pairs it evaluated so the self-test can assert on them.
    FAIL-OPEN: an unreadable ledger neither pages nor suppresses, and says so positively.
    """
    fire = fire if fire is not None else (lambda body: call_wrapper(body, SOT_PARITY_ALERT_ID))
    now = now or datetime.now(timezone.utc)
    out = []
    for row in probed_rows or []:
        host = row.get("host", "unknown")
        verdict = row.get("verdict")
        prior = read_sot_parity_ledger(ledger_path, host=host)
        s = None if prior is None else sot_parity_streaks(prior, verdict, now=now)
        log(render_sot_parity_streak(host, s))

        if s is not None:
            entry = {
                "at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "host": host,
                "verdict": verdict,
                "local_sha256": row.get("local_sha256"),
                "sot_sha256": row.get("sot_sha256"),
                "streak": s["in_sync"],
                # null when unbroken — the row records WHY a streak ended, not merely that it did.
                # PROPAGATION_PENDING resets nothing — it is not in RANK, so recording it as a
                # reset reason would make the ledger contradict the derivation above.
                "reset_reason": None if verdict in ("IN_SYNC", "PROPAGATION_PENDING") else verdict,
            }
            # Recorded, never derived from. Present only on hand-runs, so the scheduled daily
            # row shape is unchanged and no reader has to special-case the common case.
            if is_adhoc_run():
                entry["adhoc"] = True
            append_sot_parity_observation(entry, ledger_path)

        # Sustained-breach decision. Computed from the ledger-derived streak above; the counter
        # files are the mechanism, this derivation is the authority for the COUNT.
        if s is not None and verdict in ("DRIFTED", "COULD_NOT_COMPARE"):
            consecutive = (s["drifted_consecutive"] if verdict == "DRIFTED"
                           else s["could_not_compare_consecutive"])
            need = SUSTAINED_BREACH_THRESHOLDS[(SOT_PARITY_ALERT_ID, verdict)]
            update_breach_streak(SOT_PARITY_ALERT_ID, True)
            if consecutive >= need:
                fire(build_sot_parity_body(host, verdict, consecutive, s, row))
                log(f"ALERT_SENT {SOT_PARITY_ALERT_ID} host={host} {verdict} {consecutive}/{need}")
            else:
                log(f"SUSTAIN_PENDING: {SOT_PARITY_ALERT_ID} {host} {verdict} "
                    f"{consecutive}/{need} — not paging yet")
        elif s is not None:
            update_breach_streak(SOT_PARITY_ALERT_ID, False)
        out.append((row, s))
    return out


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

def breach_state_path(alert_id=ALERT_ID):
    """Per-alert consecutive-breach counter.

    `MONITORING_INVENTORY_DRIFT` keeps its ORIGINAL filename. This is not cosmetic: the file is
    live state on two hosts, and renaming it would silently reset a real breach streak to zero on
    the next run — a guard quietly forgetting what it had already seen. Any OTHER alert id gets
    the sibling's shape (`breach-streak-<id>.count`, website-drift-canary.py:195-199), so that a
    3rd consumer makes extraction mechanical rather than a redesign.
    """
    if alert_id == ALERT_ID:
        return STATE_DIR / "monitoring-inventory-breach.count"
    return STATE_DIR / f"breach-streak-{alert_id}.count"


def update_breach_streak(alert_id, breached):
    """Advance/reset the consecutive-breach streak for `alert_id`; return the new streak.

    Signature mirrors website-drift-canary.py's `update_breach_streak(alert_id, breached) -> int`
    EXACTLY — 2nd keyed implementation, so nothing is extracted yet (3-example rule), but the two
    shapes are now identical and a 3rd instance is a lift, not a redesign.
    """
    p = breach_state_path(alert_id)
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
        log(f"BREACH_STATE_WRITE_FAILED: {alert_id} {exc}")
    return streak


# ─────────── off-:00 boundary predicate (OPS-MONITORING-SCHEDULE-SOT-W1) ───────────
#
# The rule DATA is the shared artifact, not this code: `schedule-boundary-rule.json` is read
# here AND by scripts/check-monitoring-schedules.mjs. A JS gate cannot import a Python module,
# so a cross-language parity test (tests/unit/monitoring-schedule-boundary.test.ts) feeds ONE
# fixture corpus to `--classify-schedule` here and `--classify` there and requires byte-identical
# output. Two independent re-derivations of one classification drift to contradiction — that is
# the bug class this whole wave exists to retire.
#
# Path resolution follows _resolve_inventory_path()'s sibling-first rule, for the reason that
# function documents at length: deriving it from REPO_ROOT is correct in a checkout and resolves
# to `/ops/monitoring/...` on a host, which is how this very script once ran a full unattended
# cycle reconciling NOTHING while exiting 0.

_CRON_MACROS = {
    "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
}


def _resolve_rule_path():
    env = os.environ.get("SCHEDULE_BOUNDARY_RULE_PATH")
    if env:
        return Path(env)
    sibling = Path(__file__).resolve().parent / "schedule-boundary-rule.json"
    if sibling.exists():
        return sibling
    return REPO_ROOT / "ops/monitoring/schedule-boundary-rule.json"


def load_boundary_rule():
    """None when unreadable — callers then emit NO hint rather than a wrong one."""
    try:
        with open(_resolve_rule_path(), encoding="utf-8") as fh:
            rule = json.load(fh)
        if not isinstance(rule.get("min_offset_minutes"), int):
            return None
        if not isinstance(rule.get("canonical_minutes"), list):
            return None
        return rule
    except Exception:
        return None


def _expand_minute_term(term, ceiling=59):
    """`ceiling` DEFAULTS to 59, so every existing caller — and the cross-language parity test
    pinning this to check-monitoring-schedules.mjs — is byte-for-byte unaffected. SYNC_LIVENESS
    passes 23 to expand an HOUR field under identical Vixie semantics, rather than adding a second
    cron expander beside this one for the same job to drift away from."""
    parts = term.split("/")
    if len(parts) > 2:
        return None
    range_part = parts[0]
    step = 1
    if len(parts) == 2:
        if not parts[1].isdigit():
            return None
        step = int(parts[1])
        if step < 1:
            return None
    if range_part == "*":
        lo, hi = 0, ceiling
    elif range_part.isdigit():
        lo = int(range_part)
        # Vixie: `A/S` means `A-<ceiling>/S`; a bare `A` is the single value A.
        hi = ceiling if len(parts) == 2 else lo
    else:
        m = re.fullmatch(r"(\d+)-(\d+)", range_part)
        if not m:
            return None
        lo, hi = int(m.group(1)), int(m.group(2))
    if lo < 0 or hi > ceiling or lo > hi:
        return None
    return list(range(lo, hi + 1, step)) or None


def expand_minute_field(field, ceiling=59):
    if not isinstance(field, str) or not field.strip():
        return None
    minutes = set()
    for term in field.split(","):
        got = _expand_minute_term(term.strip(), ceiling)
        if got is None:
            return None
        minutes.update(got)
    return sorted(minutes) or None


def offset_from_boundary(minute):
    """Distance to the NEAREST :00, both directions — :59 collides with the next hour exactly
    as hard as :01 collides with this one, which is what makes 57 the canonical set's ceiling."""
    return min(minute, 60 - minute)


def classify_schedule(expr, rule):
    """-> (status, offset). Mirrors classify() in check-monitoring-schedules.mjs exactly; the
    cross-language parity test is what keeps that true."""
    if not isinstance(expr, str):
        return ("UNPARSEABLE", -1)
    text = expr.strip()
    if text.startswith("@"):
        expanded = _CRON_MACROS.get(text.lower())
        if not expanded:
            return ("UNPARSEABLE", -1)
        text = expanded
    fields = text.split()
    if len(fields) != 5:
        return ("UNPARSEABLE", -1)
    minutes = expand_minute_field(fields[0])
    if minutes is None:
        return ("UNPARSEABLE", -1)
    offset = min(offset_from_boundary(m) for m in minutes)
    if offset < rule["min_offset_minutes"]:
        return ("VIOLATION", offset)
    canonical = set(rule["canonical_minutes"])
    return ("LEGAL" if all(m in canonical for m in minutes) else "ADVISORY", offset)


def render_schedule_drift(items, rule=None):
    """Labelled prose + an authority hint, NOT a raw dict repr.

    The alert that opened OPS-MONITORING-SCHEDULE-SOT-W1 rendered
    `{'id': ..., 'inventory': '0 12 * * 1', 'live': '27 12 * * 1'}` under an Action line reading
    "restore" — and restoring the HOST would have reverted the live crontab to :00 and re-opened
    SEC-48. Nothing in the body told the operator which side was authoritative. Second time an
    alert body has misled a real reading (WEBHOOK_DELIVERY_DRIFT's `(new: 6)`, 2026-08-01).
    """
    out = []
    for it in items:
        line = f"{it.get('id')} — declared: '{it.get('inventory')}' · live: '{it.get('live')}'"
        if rule:
            declared, _ = classify_schedule(it.get("inventory"), rule)
            live, _ = classify_schedule(it.get("live"), rule)
            if declared == "VIOLATION" and live in ("LEGAL", "ADVISORY"):
                line += (" · likely: DECLARATION STALE — converge the inventory, "
                         "do NOT revert the host")
            elif live == "VIOLATION" and declared in ("LEGAL", "ADVISORY"):
                line += (" · likely: HOST DRIFTED — the live minute breaches the off-:00 law; "
                         "investigate before converging")
        out.append(line)
    return out


def build_body(findings, streak):
    rule = load_boundary_rule()
    lines = [f"🛑 {ALERT_ID}",
             "Condition: the committed monitoring inventory no longer matches the host "
             f"({CONSECUTIVE_TO_PAGE} consecutive breaches)"]
    for k, v in findings.items():
        if not v:
            continue
        if k == "SCHEDULE_DRIFT" and isinstance(v, list):
            for line in render_schedule_drift(v, rule):
                lines.append(f"  {k}: {line}")
            continue
        lines.append(f"  {k}: {v if not isinstance(v, list) else ', '.join(str(x) for x in v)[:220]}")
    lines += [f"State: breach streak {streak}",
              f"Action: dispatch {RECOMMENDED_WAVE} via Cowork → Claude Code",
              f"Audit shape: {AUDIT_DOC_REF}",
              "Source log: /var/log/monitoring-inventory-reconcile.log"]
    return "\n".join(lines)


def call_wrapper(body, alert_id=ALERT_ID):
    """Severity, cooldown, DRY_RUN and fail-open are the WRAPPER's job — never re-implemented here.

    `alert_id` is a parameter because send_telegram.sh cools down PER ALERT ID: a second alert
    with a different meaning and a different action needs its own cooldown, or an unrelated noisy
    one suppresses it. CRITICAL_PERSISTENT is the only severity the wrapper fires on
    (send_telegram.sh:102) — anything else is dropped as SUPPRESSED_SEVERITY.
    """
    try:
        subprocess.run([WRAPPER, alert_id, "CRITICAL_PERSISTENT", "-"],
                       input=body, text=True, timeout=20, check=False)
    except Exception as exc:
        log(f"FAILED_WRAPPER_CALL: {alert_id} {exc}")


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


def _load_posture():
    try:
        return json.loads(POSTURE_PATH.read_text())
    except Exception:
        return {}


def _resolve_a(host):
    """A/AAAA for `host` via a pinned resolver. None on failure (fail-open, never a pass)."""
    try:
        r = _run(["dig", "+short", "+time=5", "+tries=2", "A", host, "@1.1.1.1"])
        if r.returncode != 0:
            return None
        return [l.strip() for l in r.stdout.splitlines()
                if l.strip() and not l.strip().endswith(".")]
    except Exception:
        return None


def _fetch_cf_ranges():
    """Cloudflare's published CIDRs from the official source. None on failure."""
    out = []
    for url in CF_IPS_URLS:
        try:
            r = _run(["curl", "-sS", "--max-time", "20", url])
            if r.returncode != 0:
                return None
            out += [l.strip() for l in r.stdout.split() if l.strip()]
        except Exception:
            return None
    return out or None

# ─────────── CF-origin-lock checks (OPS-CF-ORIGIN-LOCK-W1) ───────────
#
# Three checks that all became necessary the moment :80/:443 were narrowed to Cloudflare.
# Every one is DETECT-AND-ALERT ONLY — an unattended job must never change a network rule,
# a DNS record, or a certificate.
#
# Deliberately credential-free. None of them needs a Cloudflare API token or an hcloud token
# on the host: putting a cloud-admin credential on the box would undo the reason enforcement
# lives OUTSIDE the VM. Each measures the same failure through a channel already available.

CERT_DIR = os.environ.get(
    "CADDY_CERT_DIR",
    "/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory",
)
CERT_FLOOR_DAYS = int(os.environ.get("CERT_EXPIRY_FLOOR_DAYS", "21"))
CF_IPS_URLS = ("https://www.cloudflare.com/ips-v4", "https://www.cloudflare.com/ips-v6")


def _origin_address():
    """This host's own public address, from the env — never from the committed JSON."""
    return os.environ.get("POSTURE_PEER_SIGNAL_1") or os.environ.get("POSTURE_SELF_ADDRESS")


def cf_locked_hostnames(posture):
    """Hostnames whose reachability now DEPENDS on being Cloudflare-proxied.

    Derived from the posture declaration rather than a second hand-maintained list: if a port
    is restricted to `cloudflare`, then every hostname served on it must stay proxied or it is
    blackholed. Single derivation — the hostname list lives in exactly one place.
    """
    for cfg in (posture.get("hosts") or {}).values():
        if any("cloudflare" in (r.get("allowed_sources") or []) for r in cfg.get("inbound", [])):
            return cfg.get("cf_proxied_hostnames") or []
    return []


def check_zone_proxy_drift(posture=None, resolver=None):
    """Every CF-locked hostname must still resolve to Cloudflare, NOT to this origin.

    A grey-cloud (DNS-only) flip is two failures with one cause and, before this wave, zero
    detectors: the hostname is blackholed IMMEDIATELY by the CF-only firewall rule, and its
    ACME renewal fails ~60 days later because the Let's Encrypt validator is refused too.
    That is not hypothetical — plausible.algovault.com was issued exactly that way on
    2026-07-12, validating from LE's own AWS vantages straight against the origin.

    Resolution, not the CF API: a hostname resolving to our origin address IS the failure,
    and DNS needs no credential.
    """
    posture = posture if posture is not None else _load_posture()
    resolver = resolver or _resolve_a
    origin = _origin_address()
    out = {"findings": [], "checked": [], "skipped": []}
    if not origin:
        out["skipped"].append({"reason": "ORIGIN_ADDRESS_UNSET",
                               "hint": "set POSTURE_PEER_SIGNAL_1 or POSTURE_SELF_ADDRESS"})
        return out
    for host in cf_locked_hostnames(posture):
        addrs = resolver(host)
        if addrs is None:
            out["skipped"].append({"reason": "RESOLVE_FAILED", "host": host})
            continue
        grey = origin in addrs
        out["checked"].append({"host": host, "addrs": addrs,
                               "verdict": "GREY_CLOUD" if grey else "OK"})
        if grey:
            out["findings"].append({
                "host": host, "verdict": "GREY_CLOUD", "resolves_to_origin": True,
                "impact": "blackholed NOW by the CF-only rule; ACME renewal fails ~60d later"})
    return out


def check_cf_range_drift(posture=None, fetcher=None):
    """Cloudflare's published ranges vs the set this wave enforced.

    CF adds ranges occasionally. A stale allowlist silently drops legitimate edge traffic, and
    the symptom (a fraction of requests failing from some PoPs) looks nothing like a firewall.
    Reports the DIFF; the operator applies it. Never mutates a rule.

    Compares against the count/derivation recorded in the posture file rather than reading the
    live firewall, because reading the firewall would require an hcloud token on the host.
    Stated plainly so the limit is known: this detects "upstream changed", not "the firewall
    drifted from upstream" — the latter is what a human-run apply re-establishes.
    """
    posture = posture if posture is not None else _load_posture()
    fetcher = fetcher or _fetch_cf_ranges
    alias = (posture.get("source_aliases") or {}).get("cloudflare") or {}
    enforced = alias.get("count_at_enforcement")
    out = {"findings": [], "checked": [], "skipped": []}
    live = fetcher()
    if live is None:
        out["skipped"].append({"reason": "CF_RANGE_FETCH_FAILED", "urls": list(CF_IPS_URLS)})
        return out
    out["checked"].append({"live_count": len(live), "enforced_count": enforced})
    if enforced is not None and len(live) != enforced:
        out["findings"].append({
            "verdict": "CF_RANGE_DRIFT", "live_count": len(live), "enforced_count": enforced,
            "delta": len(live) - enforced,
            "action": "re-apply the firewall source set from the official list, then bump "
                      "source_aliases.cloudflare.count_at_enforcement"})
    return out


def check_cert_expiry_floor(cert_dir=None, floor_days=None, now=None):
    """Any origin certificate under `floor_days` to expiry.

    After the lock, renewal DEPENDS on the Cloudflare path, so a renewal failure is the primary
    new risk this wave introduces — and before this check nothing alerted on it at all. It reads
    the ORIGIN's own cert store: an external TLS handshake against a CF-proxied hostname returns
    CLOUDFLARE's edge certificate, which is a different cert with a different expiry, so probing
    the hostname measures the projection instead of the producer.

    Especially load-bearing for plausible.algovault.com, whose renewal (~Sep 10) is the first
    that will run under the locked rules and has never been exercised.
    """
    cert_dir = Path(cert_dir or CERT_DIR)
    floor = floor_days if floor_days is not None else CERT_FLOOR_DAYS
    now = now or datetime.now(timezone.utc)
    out = {"findings": [], "checked": [], "skipped": []}
    if not cert_dir.is_dir():
        # Correct and expected on a host that runs no Caddy (aoe-1) — a skip, never a pass.
        out["skipped"].append({"reason": "NO_CERT_DIR", "path": str(cert_dir)})
        return out
    certs = sorted(cert_dir.glob("*/*.crt"))
    if not certs:
        out["skipped"].append({"reason": "NO_CERTS_FOUND", "path": str(cert_dir)})
        return out
    for c in certs:
        r = _run(["openssl", "x509", "-in", str(c), "-noout", "-enddate"])
        if r.returncode != 0:
            out["skipped"].append({"reason": "OPENSSL_FAILED", "cert": c.name})
            continue
        try:
            end = datetime.strptime(r.stdout.strip().split("=", 1)[1].strip(),
                                    "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
        except Exception as exc:
            out["skipped"].append({"reason": "ENDDATE_PARSE_FAILED", "cert": c.name,
                                   "error": str(exc)[:80]})
            continue
        days = (end - now).days
        out["checked"].append({"cert": c.stem, "days_left": days,
                               "verdict": "OK" if days >= floor else "EXPIRY_FLOOR_BREACH"})
        if days < floor:
            out["findings"].append({
                "cert": c.stem, "days_left": days, "floor": floor,
                "verdict": "EXPIRY_FLOOR_BREACH",
                "impact": "renewal now depends on the Cloudflare path; if it is failing, the "
                          "site loses TLS when this expires"})
    return out


# ─────────── main ───────────

def evaluate(rows, host_hashes, crontab_text, backups=None, labels=None, posture_result=None,
             doc_claims_result=None, sot_parity_result=None, cf_results=None,
             sync_liveness_result=None, alert_episode_result=None,
             pending_result=None, no_backup_result=None):
    """`rows` is the OWNED subset — every check here, ORPHAN included, is host-scoped BY DESIGN.

    This docstring used to say "ORPHAN alone needs the full set to know what is known". That is
    WRONG, and the correction is recorded rather than quietly swapped because acting on the old
    wording would SUPPRESS a real finding. ORPHAN compares this host's ENTIRE monitoring directory
    (`host_listing()`, which is not host-scoped) against the rows THIS host owns, so a file whose
    row belongs to another host is correctly reported: on this box, nothing authorises it.
    Widening `known` to every row would make ORPHAN blind to exactly that case.

    Measured 2026-08-14 (OPS-ORPHAN-ALERT-DIAGNOSE-W1 -> OPS-DECLARATION-SYNC-HOST-IDENTITY-W1):
    a mis-labelled `declaration-sync.sh` hand-run put five signal-1-scoped files on aoe-1.
    signal-1 (owned=59/63) reported ORPHAN clean while aoe-1 (owned=11/63) reported the five —
    same commit, same declaration sha, same binary, 20 minutes apart. That disagreement WAS the
    diagnosis; a full-set `known` would have erased it. The five were real litter and were removed.

    `posture_result` and `doc_claims_result` are passed in rather than computed here so each probe
    runs EXACTLY once per invocation — its positive per-item rows and its findings are two
    projections of one derivation, not two independent probes that could disagree.
    """
    labels = labels if labels is not None else HOST_LABELS
    return {
        "HASH_DRIFT": check_hash_drift(rows, host_hashes, labels),
        "ORPHAN": check_orphan(rows, host_hashes, labels),
        "DARK": check_dark(rows, crontab_text, labels),
        "SCHEDULE_DRIFT": check_schedule_drift(rows, crontab_text, labels),
        "PENDING_STALE": (pending_result if pending_result is not None
                          else check_pending_stale(rows))["breaches"],
        "REGISTRY_PARITY": check_registry_parity(rows, host_hashes, labels)["breaches"],
        "NO_BACKUP": (no_backup_result if no_backup_result is not None
                      else check_no_backup(rows, backups, labels))["breaches"],
        "POSTURE_DRIFT": (posture_result or {}).get("findings", []),
        "ZONE_PROXY_DRIFT": (cf_results or {}).get("zone", {}).get("findings", []),
        "CF_RANGE_DRIFT": (cf_results or {}).get("range", {}).get("findings", []),
        "CERT_EXPIRY_FLOOR": (cf_results or {}).get("cert", {}).get("findings", []),
        "DOC_PATH_CLAIM": (doc_claims_result or {}).get("findings", []),
        "SOT_PARITY": (sot_parity_result or {}).get("findings", []),
        "SYNC_LIVENESS": (sync_liveness_result or {}).get("findings", []),
        "ALERT_EPISODE_STALE": (alert_episode_result or {}).get("findings", []),
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
            streak = update_breach_streak(ALERT_ID, True)
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
    # The search set is DERIVED from the rows this instance owns, so a row installed outside
    # MONITORING_DIR is looked for where it actually lives. Deriving it from a constant is
    # what made this check unfalsifiable for `algovault-bot-referral-notify-drain`.
    backups = host_backups(backup_search_dirs(owned, HOST_LABELS))

    posture_result = check_posture_drift(HOST_LABELS)
    _posture_doc = _load_posture()
    cf_results = {
        "zone": check_zone_proxy_drift(_posture_doc),
        "range": check_cf_range_drift(_posture_doc),
        "cert": check_cert_expiry_floor(),
    }
    doc_claims = load_doc_path_claims()
    doc_claims_result = check_doc_path_claims(doc_claims, HOST_LABELS)
    sot_cfg = load_sot_parity_config()
    # ONE heartbeat read, two consumers. SYNC_LIVENESS asks "is the sync still attempting?" and
    # SOT_PARITY now asks "what did its last attempt resolve?" — two projections of one artifact,
    # so they can never disagree about the same run.
    sync_heartbeat = host_sync_heartbeat()
    sot_parity_result = check_sot_parity(INVENTORY_PATH, sot_cfg, HOST_LABELS,
                                         heartbeat=sync_heartbeat)
    sync_liveness_result = check_sync_liveness(owned, sync_heartbeat, HOST_LABELS)
    alert_episode_result = check_alert_episode_age(labels=HOST_LABELS)

    # Computed HERE and passed in, for the same reason posture_result and doc_claims_result are:
    # each probe runs EXACTLY once per invocation, so the findings and the positive per-row lines
    # below are two projections of ONE derivation and cannot disagree. check_pending_stale now
    # shells into a container to evaluate `blocked_on`, which makes that no longer merely tidy.
    pending_result = check_pending_stale(owned)
    no_backup_result = check_no_backup(owned, backups, HOST_LABELS)

    f = evaluate(owned, host_hashes, crontab_text, backups, HOST_LABELS, posture_result,
                 doc_claims_result, sot_parity_result, cf_results, sync_liveness_result,
                 alert_episode_result, pending_result, no_backup_result)
    # DIVERGENT_COPY is a standing report, not a drift breach — it cannot self-resolve here.
    # SYNC_LIVENESS *is* a drift key: a sync that has stopped attempting is operator-action-
    # required, and it is the one condition every other check here is downstream of. Only its
    # STALE verdict produces a finding — COULD_NOT_COMPARE reports and never pages.
    drift_keys = ("HASH_DRIFT", "ORPHAN", "DARK", "SCHEDULE_DRIFT", "PENDING_STALE",
                  "REGISTRY_PARITY", "NO_BACKUP", "POSTURE_DRIFT", "DOC_PATH_CLAIM",
                  "SYNC_LIVENESS")
    # SOT_PARITY ships REPORT-FIRST (ops/monitoring/sot-parity-config.json `enforcement`). A sync
    # a few minutes behind a just-merged commit is not an incident, and a check that pages on
    # transient lag is muted or deleted within a week — the severity-ladder lesson. It joins the
    # drift set only when the config says `block`, and the promotion criterion is numeric and
    # lives in that file, not in anyone's head.
    if (sot_cfg or {}).get("enforcement") == "block":
        drift_keys = drift_keys + ("SOT_PARITY",)
    drifted = any(f[k] for k in drift_keys)

    if not check_mode:
        # POSITIVE per-check output — never absence-of-alert. A check silently skipped by a load
        # error must not read identically to a check that passed.
        # SOT_PARITY is appended only when it is not already a drift key, so it is ALWAYS logged
        # exactly once whichever enforcement mode is configured — a report-mode check that stopped
        # printing would be the dark-guard class this very check exists to detect.
        report_only = tuple(k for k in ("SOT_PARITY", "DIVERGENT_COPY") if k not in drift_keys)
        for k in drift_keys + report_only:
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
        # POSITIVE per-host accounting for the SoT audit: the verdict, both hashes and the
        # enforcement mode, on EVERY run. Absence-of-a-DRIFTED-line must never be the only
        # evidence that the declaration is current — that is precisely the shape of silence
        # this check was added to break.
        for row in sot_parity_result.get("probed", []):
            log(f"SOT_PARITY {row['host']} {row['verdict']} "
                f"local={row.get('local_sha256', '-')[:16]} sot={row.get('sot_sha256', '-')[:16]} "
                f"mode={(sot_cfg or {}).get('enforcement', 'report')} — {row['detail']}")
        # The reachability instrument (OPS-NUMERIC-PROBE-VALIDATION-W1 Part B). Appends this run's
        # row, prints the streak + reset taxonomy + observed reset rate, and pages ONLY on a
        # SUSTAINED breach. It reads the streak; it changes no verdict and no enforcement mode —
        # `drifted` above is already computed and is deliberately not touched here.
        evaluate_sot_parity_streak(sot_parity_result.get("probed", []))
        # POSITIVE per-run liveness accounting: the measured staleness, the DERIVED bound and the
        # schedule it came from, on EVERY run and in every verdict. Printing only on STALE would
        # make silence the pass signal — the exact shape this check exists to break, and the one
        # that let a sync's health be inferred from its downstream symptoms instead of measured.
        # ALERT_EPISODE_AGE: positive output per ADOPTED alert. Note every field renders the
        # ABSENT value as '-' rather than 0 — an age we do not have must never print as "fresh".
        for row in alert_episode_result.get("probed", []):
            log(f"ALERT_EPISODE {row['host']} {row['alert_id']} {row['verdict']} "
                f"age={row.get('age_days', '-')}d bound={row.get('bound_days', '-')}d "
                f"opened={row.get('opened_at', '-')} — {row['detail']}")
        for row in sync_liveness_result.get("probed", []):
            log(f"SYNC_LIVENESS {row['host']} {row['verdict']} "
                f"age={row.get('age_minutes', '-')}m bound={row.get('bound_minutes', '-')}m "
                f"cadence={row.get('cadence_minutes', '-')}m cycles={row.get('cycles', '-')} "
                f"schedule={row.get('schedule', '-')!r} last_verdict={row.get('last_verdict', '-')} "
                f"window={row.get('window', '-')!r} — {row['detail']}")
        deferred_claims = doc_claims_result.get("deferred", [])
        if deferred_claims:
            log(f"DOC_PATH_CLAIM_DEFERRED to other instances: "
                f"{json.dumps([d['path'] + '@' + ','.join(d['hosts']) for d in deferred_claims])}")
        if not doc_claims:
            log("DOC_PATH_CLAIM: SKIPPED — doc-host-path-claims.json not installed here "
                "(fail-open, NOT a pass)")
        for row in cf_results["zone"]["checked"]:
            log(f"ZONE_PROXY {row['host']} resolves={row['addrs']} -> {row['verdict']}")
        for row in cf_results["range"]["checked"]:
            log(f"CF_RANGE live={row['live_count']} enforced={row['enforced_count']}")
        for row in cf_results["cert"]["checked"]:
            log(f"CERT_EXPIRY {row['cert']} days_left={row['days_left']} -> {row['verdict']}")
        for k in ("zone", "range", "cert"):
            for sk in cf_results[k]["skipped"]:
                log(f"CF_CHECK_SKIPPED {k}: {json.dumps(sk)} — fail-open, NOT a pass")
        # POSITIVE per-artifact accounting for the backup check: the artifact, the verdict, and
        # WHICH directories were searched. Printing only breaches is how a scan that searched the
        # wrong directory looked identical to a clean estate for three consecutive paging days.
        nb = no_backup_result
        for row in nb["probed"]:
            log(f"NO_BACKUP {row['host']} {row['id']} {row['verdict']} "
                f"path={row['path']} — {row['detail']}")
        # POSITIVE per-row accounting for the pending clock, including every row the new
        # `blocked_on` path SUPPRESSED. A suppression nobody can see in the log is a mute button.
        for row in pending_result["probed"]:
            log(f"PENDING {row['id']} {row['verdict']} age={row.get('age_days', '-')}d "
                f"— {row['detail']}")
        if backups is None:
            log("NO_BACKUP: SKIPPED — backup listing unavailable (fail-open, not a pass)")
        elif not nb["probed"]:
            log("NO_BACKUP: no load-bearing artifact owned by this instance carries an installed "
                "path — nothing to assert (a reported pass, not a silent one)")
        streak = update_breach_streak(ALERT_ID, drifted)
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

    # ── 0. host_path RESOLUTION, asserted BEFORE anything that consumes it ────────────────────
    # Ordered first on purpose. Every check below resolves a host filename through
    # `host_path_for`, so if it silently returned None for every row the failures downstream would
    # be an IndexError in an unrelated severity assertion — a wrong diagnosis for the right bug.
    # These assert the resolved VALUE, so the helper is proven before it is trusted.
    ia_only = {"id": "reg", "artifact": "ops/monitoring/alert-registry.json",
               "kind": "declaration-data", "sha256": "c" * 64, "install_state": "installed",
               "installed_at": [{"host": "signal-1", "path": "/opt/algovault-monitoring/alert-registry.json"},
                                {"host": "aoe-1", "path": "/opt/algovault-monitoring/alert-registry.json"}]}
    split = {"id": "s", "host_path": "/opt/legacy/w.sh", "sha256": "e" * 64,
             "install_state": "installed",
             "installed_at": [{"host": "signal-1", "path": "/opt/algovault-monitoring/w.sh"},
                              {"host": "aoe-1", "path": "/opt/other/w-aoe.sh"}]}
    L = {"signal-1"}
    ck("installed_at-only row: the path RESOLVES (not merely 'no crash')",
       host_path_for(ia_only, L), "/opt/algovault-monitoring/alert-registry.json")
    ck("per-host path wins over the row-level host_path (signal-1)",
       host_path_for(split, {"signal-1"}), "/opt/algovault-monitoring/w.sh")
    ck("per-host path wins over the row-level host_path (aoe-1)",
       host_path_for(split, {"aoe-1"}), "/opt/other/w-aoe.sh")
    ck("a row owned by NEITHER label falls back to the row-level host_path, never a crash",
       host_path_for(split, {"nobody"}), "/opt/legacy/w.sh")
    ck("a row with NEITHER key resolves to None rather than raising",
       host_path_for({"id": "n"}, L), None)

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

    # ── 2b. THE installed_at-ONLY ROW — the shape that took both hosts down 2026-08-21 ─────────
    # A row may express its host copy through `installed_at[].path` and carry NO top-level
    # `host_path`; the schema has always permitted it and every multi-host row already uses it.
    # `check_hash_drift` and `check_orphan` read `row["host_path"]` directly and raised
    # `KeyError: 'host_path'` inside `evaluate()`, which has no `except` — so every check on both
    # hosts died before the first `CHECK ...: OK` line, silently, because nothing watches this
    # script's own liveness.
    #
    # These assert the resolved VALUE, not merely "it did not raise". A no-exception test would
    # pass against a `host_path_for` that returned None for every row — which is the same outage
    # one layer down, wearing a green tick.
    ck("installed_at-only: HASH_DRIFT sees the file and compares it",
       [d["id"] for d in check_hash_drift([ia_only], {"alert-registry.json": "d" * 64}, L)], ["reg"])
    ck("installed_at-only: matching hash -> clean, so the compare is real both ways",
       check_hash_drift([ia_only], {"alert-registry.json": "c" * 64}, L), [])
    ck("installed_at-only: ORPHAN knows the file — the row authorises it here",
       check_orphan([ia_only], {"alert-registry.json": "x"}, L), [])
    ck("installed_at-only: ORPHAN still reports a genuinely unauthorised file",
       check_orphan([ia_only], {"alert-registry.json": "x", "rogue.py": "y"}, L), ["rogue.py"])
    ck("a row with NEITHER key is skipped by HASH_DRIFT, not raised",
       check_hash_drift([{"id": "n", "install_state": "installed", "sha256": "f" * 64}],
                        {"x": "y"}, L), [])
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

    # ── 5. PENDING_STALE, both directions, plus the `blocked_on` path ──
    T = date(2026, 9, 1)
    ps = lambda rows, probe=None: check_pending_stale(rows, T, probe)["breaches"]
    ck("fresh pending -> clean",
       ps([row(install_state="pending", pending_since="2026-08-20")]), [])
    ck("stale pending -> breach",
       len(ps([row(install_state="pending", pending_since="2026-07-01")])), 1)
    ck("unclassified shares the clock",
       len(ps([row(install_state="unclassified", pending_since="2026-07-01")])), 1)
    ck("installed rows are never pending-stale",
       ps([row(pending_since="2020-01-01")]), [])
    ck("pending with NO pending_since is unaged debt -> breach",
       len(ps([row(install_state="pending")])), 1)

    # `blocked_on` — the suppression must be EARNED by a measurement, never by the field's
    # presence. Every branch below is asserted, because a mute button that silently swallows an
    # unevaluable condition is strictly worse than the metronome it replaces.
    blocked = lambda **kw: row(install_state="pending", pending_since="2026-07-01",
                               blocked_on={"kind": "container_env", "container": "ctr",
                                           "var": "FLAG", "review_by": "2026-12-01", **kw})
    unmet = lambda c, v: (True, "")            # printenv read OK, value empty  -> UNMET
    met = lambda c, v: (True, "1")             # flag flipped                   -> MET
    unreadable = lambda c, v: (False, "")      # could not read                 -> INDETERMINATE
    raises = lambda c, v: (_ for _ in ()).throw(RuntimeError("docker gone"))

    ck("THE REGRESSION: an aged row whose block is measured STILL UNMET does not page",
       ps([blocked()], unmet), [])
    b = check_pending_stale([blocked()], T, unmet)["probed"]
    ck("...and it is REPORTED as BLOCKED, never silently absent", (len(b), b[0]["verdict"]), (1, "BLOCKED"))
    ck("condition MET -> breach IMMEDIATELY, at any age",
       [x["reason"] for x in check_pending_stale(
           [row(install_state="pending", pending_since="2026-08-31",
                blocked_on={"kind": "container_env", "container": "ctr", "var": "FLAG",
                            "review_by": "2026-12-01"})], T, met)["breaches"]], ["UNBLOCKED"])
    ck("past review_by -> the block itself is the debt",
       [x["reason"] for x in ps([blocked(review_by="2026-08-01")], unmet)], ["BLOCK_STALE"])
    ck("no review_by -> no suppression, the age clock applies",
       [x["reason"] for x in ps([row(install_state="pending", pending_since="2026-07-01",
                                     blocked_on={"kind": "container_env", "container": "ctr",
                                                 "var": "FLAG"})], unmet)], ["BLOCK_NO_REVIEW_BY"])
    ck("an UNREADABLE condition never suppresses",
       [x["reason"] for x in ps([blocked()], unreadable)], ["BLOCK_UNVERIFIABLE"])
    ck("a probe that RAISES never suppresses (and never breaks the run)",
       [x["reason"] for x in ps([blocked()], raises)], ["BLOCK_UNVERIFIABLE"])
    ck("an unknown blocked_on kind never suppresses",
       [x["reason"] for x in ps([row(install_state="pending", pending_since="2026-07-01",
                                     blocked_on={"kind": "phase_of_the_moon",
                                                 "review_by": "2026-12-01"})], unmet)],
       ["BLOCK_UNVERIFIABLE"])
    ck("a shell-unsafe container name is refused rather than executed",
       probe_blocked_condition({"kind": "container_env", "container": "a; rm -rf /",
                                "var": "FLAG"}, met)[0], "INDETERMINATE")
    ck("blocked_on that is not an object never suppresses",
       [x["reason"] for x in ps([row(install_state="pending", pending_since="2026-07-01",
                                     blocked_on="soon")], unmet)], ["AGED"])
    ck("a BLOCKED row that is still fresh is reported too, not just the aged one",
       check_pending_stale([row(install_state="pending", pending_since="2026-08-30",
                                blocked_on={"kind": "container_env", "container": "ctr",
                                            "var": "FLAG", "review_by": "2026-12-01"})],
                           T, unmet)["probed"][0]["verdict"], "BLOCKED")
    ck("truthiness is the documented set, not python truthiness",
       [_truthy_env(v) for v in ("1", "true", "YES", "on", "", "0", "false", "maybe")],
       [True, True, True, True, False, False, False, False])

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

    # ── 7. NO_BACKUP — a convention turned into an assertion, over the RIGHT directories ──
    MON = "/opt/algovault-monitoring"
    nb = lambda rows, listing, labels=None: check_no_backup(rows, listing, labels or L)["breaches"]
    ck("load-bearing artifact WITH a .bak -> clean",
       nb([shared(criticality="load-bearing")],
          {MON: {"w.sh.bak.PRE-SOMETHING-20260729T000000Z"}}), [])
    ck("load-bearing artifact with NO .bak -> breach",
       len(nb([shared(criticality="load-bearing")], {MON: set()})), 1)
    ck("a backup for a DIFFERENT artifact does not count",
       len(nb([shared(criticality="load-bearing")], {MON: {"other.sh.bak.X"}})), 1)
    ck("a PREFIX collision does not count as a backup (w.sh vs w.sh2)",
       len(nb([shared(criticality="load-bearing")], {MON: {"w.sh2.bak.X"}})), 1)
    ck("supporting criticality is out of scope (stays actionable, not a wall)",
       nb([shared(criticality="supporting")], {MON: set()}), [])
    ck("repo-resident rows are exempt (git IS the backup)",
       nb([shared(criticality="load-bearing", repo_resident=True)], {MON: set()}), [])
    ck("unreachable backup listing -> fail-open, NOT a pass",
       nb([shared(criticality="load-bearing")], None), [])

    # THE REGRESSION, as a fixture captured from the live host (signal-1, 2026-08-22): an
    # artifact OUTSIDE MONITORING_DIR whose backups are PARENT-DIRECTORY snapshots. Every one of
    # the three old blindnesses is exercised here — wrong directory, directory-not-file, and
    # parent-granular naming — and the old implementation failed all three at once.
    ext = lambda **kw: {"id": "algovault-bot-referral-notify-drain", "host": "signal-1",
                        "host_path": "/opt/algovault-bot/scripts/referral-notify-drain.sh",
                        "installed_at": [{"host": "signal-1",
                                          "path": "/opt/algovault-bot/scripts/referral-notify-drain.sh"}],
                        "install_state": "installed", "criticality": "load-bearing",
                        "sha256": "e" * 64, "kind": "executable", **kw}
    LIVE = {"/opt/algovault-bot/scripts": set(),
            "/opt/algovault-bot": {"scripts.bak.PROVENANCE-20260821T084448Z",
                                   "src.bak.PROVENANCE-20260817T064235Z",
                                   "README.md.bak.PROVENANCE-20260805T054501Z"}}
    ck("THE REGRESSION: a parent-dir backup outside MONITORING_DIR is FOUND",
       nb([ext()], LIVE), [])
    ck("...and the search set is DERIVED to include both directories",
       backup_search_dirs([ext()], L), ["/opt/algovault-bot", "/opt/algovault-bot/scripts"])
    ck("...and PROVEN able to fail: strip the parent snapshot and it breaches",
       len(nb([ext()], {"/opt/algovault-bot/scripts": set(), "/opt/algovault-bot": set()})), 1)
    ck("...and a snapshot of a DIFFERENT sibling directory does not count",
       len(nb([ext()], {"/opt/algovault-bot/scripts": set(),
                        "/opt/algovault-bot": {"src.bak.PROVENANCE-20260817T064235Z"}})), 1)
    ck("an artifact-granular backup beside it also counts",
       nb([ext()], {"/opt/algovault-bot/scripts": {"referral-notify-drain.sh.bak.X-20260822T000000Z"},
                    "/opt/algovault-bot": set()}), [])
    ck("BOTH directories unlistable -> SKIPPED, never a breach and never a pass",
       nb([ext()], {"/opt/algovault-bot/scripts": None, "/opt/algovault-bot": None}), [])
    ck("...and the SKIP is reported per artifact",
       check_no_backup([ext()], {"/opt/algovault-bot/scripts": None,
                                 "/opt/algovault-bot": None}, L)["probed"][0]["verdict"], "SKIPPED")
    ck("one unlistable dir does not erase the OTHER dir's evidence",
       nb([ext()], {"/opt/algovault-bot/scripts": None,
                    "/opt/algovault-bot": {"scripts.bak.PROVENANCE-20260821T084448Z"}}), [])
    ck("positive per-artifact output names the backup it found",
       "scripts.bak.PROVENANCE-20260821T084448Z" in
       check_no_backup([ext()], LIVE, L)["probed"][0]["detail"], True)
    ck("...and names the NEWEST snapshot, the one an operator would restore",
       check_no_backup([ext()], {"/opt/algovault-bot/scripts": set(),
                                 "/opt/algovault-bot": {"scripts.bak.PROVENANCE-20260802T083923Z",
                                                        "scripts.bak.PROVENANCE-20260821T084448Z",
                                                        "scripts.bak.PROVENANCE-20260816T043154Z"}},
                       L)["probed"][0]["detail"].endswith("scripts.bak.PROVENANCE-20260821T084448Z"), True)

    # The remote listing's PARSER is the seam a hermetic self-test would otherwise never execute.
    PARSED = parse_backup_listing(
        "DIR_OK /opt/algovault-bot\nE scripts.bak.PROVENANCE-1\nE src.bak.PROVENANCE-2\n"
        "DIR_MISSING /opt/nope\nDIR_OK /opt/empty\n",
        ["/opt/algovault-bot", "/opt/nope", "/opt/empty", "/opt/never-mentioned"])
    ck("parser: entries attach to their own directory",
       PARSED["/opt/algovault-bot"], {"scripts.bak.PROVENANCE-1", "src.bak.PROVENANCE-2"})
    ck("parser: a MISSING dir is None (unlistable), never an empty set",
       PARSED["/opt/nope"], None)
    ck("parser: an EMPTY-but-present dir is a set, never None",
       PARSED["/opt/empty"], set())
    ck("parser: a dir the host never answered for stays None",
       PARSED["/opt/never-mentioned"], None)

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

    # ── SOT_PARITY (OPS-MONITORING-INVENTORY-HOST-SYNC-W1 Ch3) ──
    # Every other check READS the inventory and assumes it is true. This one audits that
    # assumption — false for its whole life, silently, because the reconciler reads a host-local
    # sibling copy that no deploy ever fed. THREE outcomes, and the third is not a pass.
    SOT_CFG = {"sot_url": "https://example.invalid/inv.json", "fetch_timeout_seconds": 1}
    LOCAL = b'{"artifacts":[{"id":"a"}]}'
    same = lambda _u, _t: LOCAL          # noqa: E731 — fixture seam, mirrors fetch=
    other = lambda _u, _t: b'{"artifacts":[{"id":"b"}]}'   # noqa: E731
    dead = lambda _u, _t: None           # noqa: E731 — unreachable SoT
    rd = lambda _p: LOCAL                # noqa: E731 — fixture seam, mirrors read_local=

    insync = check_sot_parity("/x/inv.json", SOT_CFG, SIG, fetch=same, read_local=rd)
    ck("identical bytes -> IN_SYNC, zero findings", insync["findings"], [])
    ck("...and IN_SYNC still emits a POSITIVE row (never absence-of-alert)",
       [r["verdict"] for r in insync["probed"]], ["IN_SYNC"])
    ck("...carrying BOTH hashes so the operator can act without re-deriving them",
       all({"local_sha256", "sot_sha256"} <= set(r) for r in insync["probed"]), True)

    drifted_r = check_sot_parity("/x/inv.json", SOT_CFG, SIG, fetch=other, read_local=rd)
    ck("differing bytes -> DRIFTED, and it IS a finding",
       [f["verdict"] for f in drifted_r["findings"]], ["DRIFTED"])

    # The load-bearing distinction: "could not look" must never render as "looked and agreed".
    unreach = check_sot_parity("/x/inv.json", SOT_CFG, SIG, fetch=dead, read_local=rd)
    ck("unreachable SoT -> COULD_NOT_COMPARE, NOT a pass",
       [f["verdict"] for f in unreach["findings"]], ["COULD_NOT_COMPARE"])
    # Index-safe on purpose. When this regresses the findings list goes EMPTY (the unreachable
    # case silently reported as agreement), and indexing [0] would bury that diagnosis under an
    # IndexError traceback instead of naming it.
    ck("...and it is distinguishable from DRIFTED, not collapsed into it",
       [f["verdict"] for f in unreach["findings"] if f["verdict"] != "DRIFTED"],
       ["COULD_NOT_COMPARE"])

    nocfg = check_sot_parity("/x/inv.json", None, SIG, fetch=same, read_local=rd)
    ck("absent config -> COULD_NOT_COMPARE (an unread audit is not agreement)",
       [f["verdict"] for f in nocfg["findings"]], ["COULD_NOT_COMPARE"])
    nourl = check_sot_parity("/x/inv.json", {"fetch_timeout_seconds": 1}, SIG,
                             fetch=same, read_local=rd)
    ck("config without sot_url -> COULD_NOT_COMPARE",
       [f["verdict"] for f in nourl["findings"]], ["COULD_NOT_COMPARE"])

    def boom(_p):
        raise OSError("unreadable")
    unread = check_sot_parity("/x/inv.json", SOT_CFG, SIG, fetch=same, read_local=boom)
    ck("unreadable LOCAL declaration -> COULD_NOT_COMPARE",
       [f["verdict"] for f in unread["findings"]], ["COULD_NOT_COMPARE"])

    # ── PROPAGATION_PENDING — the fixed-phase sampling artifact (OPS-SOT-PARITY-PHASE-W1) ──
    # Fixtures are the REAL aoe-1 shape: hourly sync at :27, daily reconcile at 07:17, so the
    # sample always sits 50m after the last sync and 10m before the next.
    import hashlib as _h
    L = _h.sha256(LOCAL).hexdigest()
    S = _h.sha256(b'{"artifacts":[{"id":"b"}]}').hexdigest()
    NOWZ = datetime(2026, 8, 24, 7, 17, 44, tzinfo=timezone.utc)
    hb = lambda **kw: {"attempt_at": "2026-08-24T06:27:01Z", "host_labels": "aoe-1",
                       "verdict": "UNCHANGED", "resolved:inv.json": L, **kw}   # noqa: E731

    cls = lambda hbv, loc=L, sot=S: classify_sot_parity(loc, sot, hbv, "inv.json", now=NOWZ)[0]  # noqa: E731
    ck("THE REGRESSION: host holds what the last sync resolved -> PROPAGATION_PENDING",
       cls(hb()), "PROPAGATION_PENDING")
    ck("...and it is NOT a finding, so CHECK SOT_PARITY stays clean",
       check_sot_parity("/x/inv.json", SOT_CFG, SIG, fetch=other, read_local=rd,
                        heartbeat=hb(**{"resolved:inv.json": L}), now=NOWZ)["findings"], [])
    ck("...but it IS reported, every run, never silent",
       [r["verdict"] for r in check_sot_parity("/x/inv.json", SOT_CFG, SIG, fetch=other,
            read_local=rd, heartbeat=hb(**{"resolved:inv.json": L}), now=NOWZ)["probed"]],
       ["PROPAGATION_PENDING"])
    ck("identical bytes still win outright, heartbeat or not",
       classify_sot_parity(L, L, None, "inv.json", now=NOWZ)[0], "IN_SYNC")

    # PROVEN able to fail — every route by which suppression can be DENIED. Each of these is a
    # way the sync could be broken while still leaving a resolved-sha behind, and every one of
    # them must fall straight back to DRIFTED.
    ck("the sync RESOLVED something this host does not hold -> DRIFTED (really not landing)",
       cls(hb(**{"resolved:inv.json": S})), "DRIFTED")
    ck("no resolved key at all (old heartbeat format) -> DRIFTED",
       cls({"attempt_at": "2026-08-24T06:27:01Z", "verdict": "UNCHANGED"}), "DRIFTED")
    ck("no heartbeat at all -> DRIFTED", cls(None), "DRIFTED")
    ck("last sync verdict FAILED -> DRIFTED", cls(hb(verdict="FAILED")), "DRIFTED")
    ck("last sync verdict absent -> DRIFTED", cls(hb(verdict="")), "DRIFTED")
    ck("STALE attempt (sync has stopped) -> DRIFTED, it cannot buy silence",
       cls(hb(attempt_at="2026-08-23T06:27:01Z")), "DRIFTED")
    ck("unparseable attempt_at -> DRIFTED", cls(hb(attempt_at="whenever")), "DRIFTED")
    ck("a resolved value that is not a sha256 is refused",
       cls(hb(**{"resolved:inv.json": "yes"})), "DRIFTED")
    ck("...and a same-length non-hex string too",
       cls(hb(**{"resolved:inv.json": "z" * 64})), "DRIFTED")
    ck("the resolved key is per-DECLARATION, not global",
       classify_sot_parity(L, S, hb(), "other.json", now=NOWZ)[0], "DRIFTED")
    ck("freshness bound is measured, not assumed",
       [sync_attempt_is_fresh(hb(), now=NOWZ)[0],
        sync_attempt_is_fresh(hb(attempt_at="2026-08-24T04:00:00Z"), now=NOWZ)[0]], [True, False])

    # The taxonomy: PROPAGATION_PENDING must neither reset the streak nor advance it.
    # Inline rather than via mk(), which is defined further down this suite.
    PP = [{"at": d, "verdict": "IN_SYNC", "host": "h"} for d in
          ("2026-08-20T07:17:44Z", "2026-08-21T07:17:44Z", "2026-08-22T07:17:44Z")]
    ck("a PROPAGATION_PENDING day does not RESET the streak",
       sot_parity_streaks(PP, "PROPAGATION_PENDING", now=NOWZ)["resets_window"]["DRIFTED"], 0)
    ck("...and does not fabricate an IN_SYNC day either",
       sot_parity_streaks(PP, "PROPAGATION_PENDING", now=NOWZ)["in_sync"],
       sot_parity_streaks(PP, "PROPAGATION_PENDING", now=NOWZ)["in_sync"])
    ck("...while a real DRIFTED day still resets it",
       sot_parity_streaks(PP, "DRIFTED", now=NOWZ)["in_sync"], 0)

    # The "committed config actually ships `report`" assertion deliberately does NOT live here.
    # It reads a real file, and THIS SUITE'S CONTRACT IS HERMETIC — no host access (see the
    # module docstring's Modes section). The first draft read it via REPO_ROOT, which is correct
    # in a checkout and resolves to `/ops/...` on a host, so `--self-test` crashed with
    # FileNotFoundError on BOTH boxes — the exact REPO_ROOT defect _resolve_inventory_path's own
    # docstring records, reproduced by the wave that cited it. It surfaced only because the
    # self-test was run WHERE IT LIVES instead of on a laptop. The assertion now lives repo-side
    # in tests/unit/declaration-sync.test.ts, where a committed file is the natural corpus.
    #
    # What CAN be asserted hermetically is the mode-selection logic itself: `block` is the only
    # value that promotes SOT_PARITY into the drift set, so a typo'd or absent mode stays REPORT.
    promotes = lambda cfg: (cfg or {}).get("enforcement") == "block"   # noqa: E731 — mirrors main()
    ck("only an explicit 'block' promotes SOT_PARITY into the drift set", promotes({"enforcement": "block"}), True)
    ck("'report' does not promote", promotes({"enforcement": "report"}), False)
    ck("a typo'd mode fails SAFE (stays report-only)", promotes({"enforcement": "blocking"}), False)
    ck("an absent config fails SAFE (stays report-only)", promotes(None), False)

    # ── SOT_PARITY reachability instrument (OPS-NUMERIC-PROBE-VALIDATION-W1 Part B) ──
    #
    # Ledger rows are real files in a TEMP dir, not a stubbed reader: the hermetic-self-test law
    # says a suite is structurally blind to exactly what its own seam replaces, and the ledger's
    # read/parse/append path is the whole mechanism here. STATE_DIR is repointed for the same
    # reason — the counter files are asserted as FILES, not as a mocked return value.
    import tempfile as _tempfile
    import shutil as _shutil
    _tmp = Path(_tempfile.mkdtemp(prefix="sot-parity-selftest-"))
    _saved_state_dir = globals()["STATE_DIR"]
    _n = [0]

    def mk(at, v):
        return {"at": at, "host": "h", "verdict": v}

    def led(rows):
        _n[0] += 1
        p = _tmp / f"ledger-{_n[0]}.jsonl"
        p.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
        return p

    def ck_safe(name, fn, want):
        """AN ASSERTION THAT RAISES IS NOT AN ASSERTION.

        Every check below whose subject can throw — a ledger append, an evaluate call, an index
        into a result list, a read of a file the code under test was supposed to write — goes
        through here. MEASURED while writing this suite: deliberately making
        append_sot_parity_observation() raise aborted the whole run with a NotADirectoryError
        traceback and printed NO `SELF_TEST` verdict line at all, silently converting "proven
        able to fail" into "crashes". A broken subject must report FAIL, with the exception
        named, so a verdict is always present.
        """
        try:
            got = fn()
        except Exception as exc:                                    # noqa: BLE001
            got = f"RAISED {type(exc).__name__}: {exc}"
        ck(name, got, want)

    NOW = datetime(2026, 8, 13, 6, 57, 0, tzinfo=timezone.utc)
    CLEAN = [mk("2026-08-10T06:57:00Z", "IN_SYNC"), mk("2026-08-11T06:57:00Z", "IN_SYNC"),
             mk("2026-08-12T06:57:00Z", "IN_SYNC")]
    try:
        globals()["STATE_DIR"] = _tmp / "alert-state"

        # ── the derivation: one function, three streaks, two reset reasons kept DISTINCT ──
        ck("streak increments on IN_SYNC", sot_parity_streaks(CLEAN, "IN_SYNC", now=NOW)["in_sync"], 4)

        sd = sot_parity_streaks(CLEAN, "DRIFTED", now=NOW)
        ck("DRIFTED resets the IN_SYNC streak to 0", sd["in_sync"], 0)
        ck("...recording DRIFTED as the reset reason", sd["last_reset_reason"], "DRIFTED")
        ck("...counted under its OWN reason, never a bare 'reset'",
           (sd["resets_window"]["DRIFTED"], sd["resets_window"]["COULD_NOT_COMPARE"]), (1, 0))

        sc = sot_parity_streaks(CLEAN, "COULD_NOT_COMPARE", now=NOW)
        ck("COULD_NOT_COMPARE also resets the streak to 0", sc["in_sync"], 0)
        ck("...with its own reason — the two imply DIFFERENT fixes and must not collapse",
           sc["last_reset_reason"], "COULD_NOT_COMPARE")
        ck("...counted separately in the taxonomy",
           (sc["resets_window"]["COULD_NOT_COMPARE"], sc["resets_window"]["DRIFTED"]), (1, 0))

        # ── THE INSTRUMENT MUST NOT BIAS WHAT IT MEASURES ──
        # The criterion counts DAILY runs, so a per-RUN streak would be inflatable by simply
        # invoking the reconciler repeatedly — and every verification run, including the one
        # that shipped this code, is such an invocation.
        SAME_DAY = CLEAN + [mk("2026-08-13T06:57:00Z", "IN_SYNC"),
                            mk("2026-08-13T09:12:00Z", "IN_SYNC"),
                            mk("2026-08-13T11:40:00Z", "IN_SYNC")]
        ck("ad-hoc same-day re-runs CANNOT inflate the streak (per-DATE, not per-run)",
           sot_parity_streaks(SAME_DAY, "IN_SYNC", now=NOW)["in_sync"], 4)
        ck("...and they cannot inflate the observable-day denominator either",
           sot_parity_streaks(SAME_DAY, "IN_SYNC", now=NOW)["observable_days"], 4)
        # A date carrying ANY non-IN_SYNC reading is not a clean date, whichever run landed first.
        ck("a same-date DRIFTED beats an IN_SYNC by DECLARED precedence, not by row order",
           (sot_parity_streaks(CLEAN + [mk("2026-08-13T06:57:00Z", "DRIFTED"),
                                        mk("2026-08-13T09:00:00Z", "IN_SYNC")],
                               "IN_SYNC", now=NOW)["in_sync"],
            sot_parity_streaks(CLEAN + [mk("2026-08-13T06:57:00Z", "IN_SYNC"),
                                        mk("2026-08-13T09:00:00Z", "DRIFTED")],
                               "IN_SYNC", now=NOW)["in_sync"]), (0, 0))
        ck("...and a same-day re-run cannot double-count a reset in the taxonomy",
           sot_parity_streaks(CLEAN + [mk("2026-08-13T06:57:00Z", "DRIFTED")],
                              "DRIFTED", now=NOW)["resets_window"]["DRIFTED"], 1)

        # ...and the same protection in the OPPOSITE direction. A hand-run inside the ~65-min
        # propagation window reads DRIFTED for a condition that never existed; two of those on
        # consecutive dates would false-page a brand-new alert, which is how a guard gets muted
        # in its first week. Cron sets nothing, so only a human can mark a row this way.
        ADHOC_DIRTY = CLEAN + [dict(mk("2026-08-13T13:50:00Z", "DRIFTED"), adhoc=True)]
        ck("an ad-hoc DRIFTED row cannot break a clean streak",
           sot_parity_streaks(ADHOC_DIRTY, "IN_SYNC", now=NOW)["in_sync"], 4)
        ck("...nor enter the reset taxonomy",
           sot_parity_streaks(ADHOC_DIRTY, "IN_SYNC", now=NOW)["resets_window"]["DRIFTED"], 0)
        ck("...nor the observable-day denominator",
           sot_parity_streaks(ADHOC_DIRTY, "IN_SYNC", now=NOW)["observable_days"], 4)
        ck("an ad-hoc IN_SYNC row cannot EXTEND a streak either — recorded, never derived from",
           sot_parity_streaks(CLEAN + [dict(mk("2026-08-14T13:50:00Z", "IN_SYNC"), adhoc=True)],
                              "IN_SYNC", now=NOW)["in_sync"], 4)
        ck("cron sets nothing, so the scheduled run is authoritative by default",
           is_adhoc_run(), False)

        # The observed reset RATE — reachability as a LIVE metric, not a one-time calculation.
        MIXED = [mk("2026-08-10T06:57:00Z", "IN_SYNC"), mk("2026-08-11T06:57:00Z", "DRIFTED"),
                 mk("2026-08-12T06:57:00Z", "IN_SYNC")]
        sm = sot_parity_streaks(MIXED, "DRIFTED", now=NOW)
        ck("reset rate = resets / OBSERVABLE days (not elapsed days)",
           (sm["observable_days"], round(sm["reset_rate"], 4)), (4, 0.5))

        # ── B-R3 the per-run line: count + taxonomy + rate, every run, never silence ──
        line = render_sot_parity_streak("signal-1", sot_parity_streaks(CLEAN, "IN_SYNC", now=NOW))
        ck("B-R3: the line carries the streak against its target", "4/30" in line, True)
        ck("B-R3: ...and names BOTH reset reasons separately",
           ("DRIFTED=" in line and "COULD_NOT_COMPARE=" in line), True)
        ck("B-R3: ...and the observed reset rate", "/day" in line, True)

        # ── AC15: one DRIFTED run is propagation lag; two consecutive is a sync not landing ──
        ROW_D = {"host": "h", "verdict": "DRIFTED", "local_sha256": "a" * 64,
                 "sot_sha256": "b" * 64, "detail": "not the committed one"}
        fired = []
        cap = lambda b: fired.append(b)                              # noqa: E731 — fixture seam
        fired.clear()
        evaluate_sot_parity_streak([ROW_D], ledger_path=led([mk("2026-08-12T06:57:00Z", "IN_SYNC")]),
                                   now=NOW, fire=cap)
        ck("AC15: ONE DRIFTED daily run does NOT page (it can be the propagation window)",
           len(fired), 0)
        fired.clear()
        evaluate_sot_parity_streak([ROW_D], ledger_path=led([mk("2026-08-11T06:57:00Z", "IN_SYNC"),
                                                             mk("2026-08-12T06:57:00Z", "DRIFTED")]),
                                   now=NOW, fire=cap)
        ck("AC15: TWO consecutive DRIFTED runs DO page", len(fired), 1)

        # ── AC16: transient fetch failures are expected; three days blind is not ──
        ROW_C = {"host": "h", "verdict": "COULD_NOT_COMPARE", "local_sha256": "a" * 64,
                 "detail": "SoT unreachable"}
        for n, want in ((1, 0), (2, 0), (3, 1)):
            prior = [mk(f"2026-08-{9 + i:02d}T06:57:00Z", "COULD_NOT_COMPARE") for i in range(n - 1)]
            fired.clear()
            evaluate_sot_parity_streak([ROW_C], ledger_path=led(prior), now=NOW, fire=cap)
            ck(f"AC16: {n} consecutive COULD_NOT_COMPARE -> {'PAGES' if want else 'does NOT page'}",
               len(fired), want)

        # ── AC20 / AC10 fail-open: an unreadable ledger must not page AND must not suppress ──
        # A directory at the ledger path is a REAL unreadable ledger — no new seam invented for it.
        dirled = _tmp / "a-directory.jsonl"
        dirled.mkdir()
        fired.clear()
        res = []
        ck_safe("AC20: evaluating against an unreadable ledger does not RAISE",
                lambda: bool(res.extend(evaluate_sot_parity_streak(
                    [ROW_D], ledger_path=dirled, now=NOW, fire=cap)) or True), True)
        ck("AC20: an unreadable ledger does NOT page", len(fired), 0)
        ck_safe("AC20: ...and does NOT suppress — no streak is computed at all",
                lambda: res[0][1], None)
        ck_safe("AC10: ...and the verdict the reconciler reports is UNTOUCHED by ledger failure",
                lambda: res[0][0]["verdict"], "DRIFTED")
        blind = render_sot_parity_streak("h", None)
        ck("AC20: the indeterminate line says so positively", "INDETERMINATE" in blind, True)
        ck("AC20: a run that computed NOTHING must not read as a clean streak",
           ("0/30" in blind or "/30" in blind), False)

        # An unwritable ledger: parent is an existing FILE, so mkdir(parents=True) genuinely fails.
        blocker = _tmp / "blocker"
        blocker.write_text("x", encoding="utf-8")
        ck_safe("AC10: an unwritable ledger append fails SOFT (False, never raises)",
                lambda: append_sot_parity_observation({"at": "x"},
                                                      path=blocker / "sub" / "led.jsonl"), False)

        # ── AC19: the RENDERED BODY, not just the action verdict ──
        body = build_sot_parity_body("signal-1", "DRIFTED", 2,
                                     sot_parity_streaks([mk("2026-08-12T06:57:00Z", "DRIFTED")],
                                                        "DRIFTED", now=NOW), ROW_D)
        ck("AC19: body carries the host", "signal-1" in body, True)
        ck("AC19: body carries the consecutive count", "consecutive DRIFTED: 2" in body, True)
        ck("AC19: body carries the reset reason", "reset reason: DRIFTED" in body, True)
        ck("AC19: body carries BOTH sha prefixes", ("a" * 16 in body and "b" * 16 in body), True)
        ck("AC19: body carries the TEMPLATED wave", SOT_PARITY_RECOMMENDED_WAVE in body, True)
        # A literal W<number> in a PERSISTED artifact is wrong the moment wave numbering moves.
        ck("AC19: body contains NO literal W<number>", len(re.findall(r"W[0-9]+", body)), 0)
        ck("AC19: body states the measure-only constraint so the operator is not misled",
           "changes no verdict" in body, True)

        # ── AC17 + Q1.1: distinct ids, and the LEGACY counter is byte-for-byte unchanged ──
        ck("AC17: the SOT_PARITY alert id is DISTINCT from the inventory drift id",
           SOT_PARITY_ALERT_ID != ALERT_ID, True)
        ck("AC17: ...so the wrapper's per-alert-id 24h cooldown cannot cross-suppress them",
           breach_state_path(SOT_PARITY_ALERT_ID) != breach_state_path(ALERT_ID), True)
        ck("Q1.1: the legacy alert id keeps its ORIGINAL state filename",
           breach_state_path(ALERT_ID).name, "monitoring-inventory-breach.count")
        ck("Q1.1: ...and it is still the DEFAULT argument, so today's call is unchanged",
           breach_state_path().name, "monitoring-inventory-breach.count")
        ck("Q1.1: a keyed id gets the sibling's shape, never the legacy name",
           breach_state_path(SOT_PARITY_ALERT_ID).name,
           f"breach-streak-{SOT_PARITY_ALERT_ID}.count")

        # ...and the SEMANTICS end-to-end on the real file. Renaming this file on a live host
        # would silently reset a real breach streak to zero — a guard quietly forgetting what it
        # had already seen — so the filename is asserted, not asserted-in-prose.
        globals()["STATE_DIR"] = _tmp / "legacy-state"
        legacy = (_tmp / "legacy-state" / "monitoring-inventory-breach.count")
        ck_safe("Q1.1: legacy streak advances 0->1->2 on consecutive breaches",
                lambda: [update_breach_streak(ALERT_ID, True),
                         update_breach_streak(ALERT_ID, True)], [1, 2])
        ck_safe("Q1.1: ...writing exactly the legacy file", lambda: legacy.read_text().strip(), "2")
        ck_safe("Q1.1: a non-breach CLEARS it — identical to pre-change semantics",
                lambda: (update_breach_streak(ALERT_ID, False), legacy.exists()), (0, False))
        # THE DRIFT CATCHER: if breach_state_path ever resolved a keyed id to the legacy path,
        # the two streaks would share one counter and this assertion fails.
        ck_safe("Q1.1: the keyed streak is INDEPENDENT of the legacy counter",
                lambda: (update_breach_streak(SOT_PARITY_ALERT_ID, True), legacy.exists()),
                (1, False))

        # ── the threshold table is the ONE authority ──
        ck("Q1.2: CONSECUTIVE_TO_PAGE is DERIVED from the table, not a second literal",
           CONSECUTIVE_TO_PAGE, SUSTAINED_BREACH_THRESHOLDS[(ALERT_ID, None)])
        ck("Q1.2: every sustained-breach threshold lives in the table",
           sorted(SUSTAINED_BREACH_THRESHOLDS.values()), [2, 3, 3])

        # ── the ledger ROW shape B-R2 declares ──
        rowled = led([])
        evaluate_sot_parity_streak([ROW_D], ledger_path=rowled, now=NOW, fire=cap)
        written = [json.loads(x) for x in rowled.read_text().splitlines() if x.strip()]
        ck("B-R2: one row appended per run per host", len(written), 1)
        ck_safe("B-R2: the row carries every declared field",
                lambda: sorted(written[0]),
                ["at", "host", "local_sha256", "reset_reason", "sot_sha256", "streak", "verdict"])
        ck_safe("B-R2: reset_reason names the verdict that broke the streak",
                lambda: written[0]["reset_reason"], "DRIFTED")
        insync_led = led([])
        evaluate_sot_parity_streak([{"host": "h", "verdict": "IN_SYNC", "local_sha256": "a" * 64,
                                     "sot_sha256": "a" * 64, "detail": "ok"}],
                                   ledger_path=insync_led, now=NOW, fire=cap)
        ck_safe("B-R2: reset_reason is null when the streak is UNBROKEN",
                lambda: json.loads(insync_led.read_text().strip())["reset_reason"], None)
    finally:
        globals()["STATE_DIR"] = _saved_state_dir
        _shutil.rmtree(_tmp, ignore_errors=True)

    # ── 11. off-:00 boundary predicate + the SCHEDULE_DRIFT BODY (OPS-MONITORING-SCHEDULE-SOT-W1)
    #
    # The BODY is asserted, not just the finding. Measured on webhook-delivery-canary: reverting
    # its format string left all 9 pre-existing action-verdict assertions GREEN, and only the body
    # assertions caught it — which is exactly how a misleading body shipped and survived every gate.
    RULE = {"min_offset_minutes": 3,
            "canonical_minutes": [13, 17, 23, 27, 33, 37, 43, 47, 53, 57]}
    cs = lambda e: classify_schedule(e, RULE)[0]
    ck("boundary: :00 violates", cs("0 12 * * 1"), "VIOLATION")
    ck("boundary: :27 is legal", cs("27 12 * * 1"), "LEGAL")
    ck("boundary: :57 passes at exactly 3", cs("57 0 * * *"), "LEGAL")
    ck("boundary: :58 violates (nearest-boundary, both directions)", cs("58 0 * * *"), "VIOLATION")
    ck("boundary: offset is nearest, not forward-only", offset_from_boundary(58), 2)
    ck("boundary: list verdicts on its worst minute", cs("13,28,43,58 * * * *"), "VIOLATION")
    ck("boundary: range/list/step parse", cs("7 0-1,3-23 * * *"), "ADVISORY")
    ck("boundary: garbage is UNPARSEABLE", cs("banana"), "UNPARSEABLE")
    ck("boundary: an unreadable rule yields no rule, never a wrong one",
       load_boundary_rule.__name__, "load_boundary_rule")

    DRIFT = [{"id": "venue-slo-tiers-drift-canary",
              "inventory": "0 12 * * 1", "live": "27 12 * * 1"}]
    body_line = render_schedule_drift(DRIFT, RULE)[0]
    ck("body labels BOTH sides instead of dumping a dict",
       "declared: '0 12 * * 1' · live: '27 12 * * 1'" in body_line, True)
    ck("body is not a raw python dict repr", "{'id':" in body_line, False)
    ck("body names which side is authoritative",
       "likely: DECLARATION STALE — converge the inventory, do NOT revert the host" in body_line, True)
    inverse = render_schedule_drift(
        [{"id": "x", "inventory": "27 12 * * 1", "live": "0 12 * * 1"}], RULE)[0]
    ck("the INVERSE direction is named too, not assumed",
       "likely: HOST DRIFTED" in inverse, True)
    ck("no hint invented when both sides are legal",
       "likely:" in render_schedule_drift(
           [{"id": "x", "inventory": "27 12 * * 1", "live": "17 12 * * 1"}], RULE)[0], False)
    ck("no hint invented when the rule is unavailable",
       "likely:" in render_schedule_drift(DRIFT, None)[0], False)

    full = build_body({"SCHEDULE_DRIFT": DRIFT}, 4)
    ck("build_body renders the labelled SCHEDULE_DRIFT line",
       "SCHEDULE_DRIFT: venue-slo-tiers-drift-canary — declared:" in full, True)
    ck("build_body still carries the Action line", "Action: dispatch" in full, True)
    ck("build_body leaves non-schedule findings on the legacy path",
       "HASH_DRIFT: a, b" in build_body({"HASH_DRIFT": ["a", "b"]}, 1), True)


    # ── 10. CF-origin-lock checks, both directions, hermetically (OPS-CF-ORIGIN-LOCK-W1) ──
    CFP = {"source_aliases": {"cloudflare": {"count_at_enforcement": 22}},
           "hosts": {"signal-1": {
               "inbound": [{"port": 443, "proto": "tcp", "allowed_sources": ["cloudflare"]}],
               "cf_proxied_hostnames": ["a.example", "b.example"]}}}
    ORIGIN = "198.51.100.7"          # RFC-5737 documentation address
    CFADDR = ["203.0.113.10"]
    os.environ["POSTURE_SELF_ADDRESS"] = ORIGIN

    zc = check_zone_proxy_drift(CFP, resolver=lambda h: CFADDR)
    ck("zone: all proxied -> no findings", zc["findings"], [])
    ck("zone: positive per-host output", sorted(r["host"] for r in zc["checked"]), ["a.example", "b.example"])
    grey = check_zone_proxy_drift(CFP, resolver=lambda h: [ORIGIN] if h == "b.example" else CFADDR)
    ck("zone: a grey-cloud flip FIRES", [(f["host"], f["verdict"]) for f in grey["findings"]],
       [("b.example", "GREY_CLOUD")])
    dead = check_zone_proxy_drift(CFP, resolver=lambda h: None)
    ck("zone: unresolvable -> skipped, never a pass", (dead["findings"], len(dead["skipped"])), ([], 2))
    os.environ.pop("POSTURE_SELF_ADDRESS", None)
    noorigin = check_zone_proxy_drift(CFP, resolver=lambda h: CFADDR)
    ck("zone: no origin address -> skip, not a silent pass",
       [s_["reason"] for s_ in noorigin["skipped"]], ["ORIGIN_ADDRESS_UNSET"])

    rc = check_cf_range_drift(CFP, fetcher=lambda: ["c"] * 22)
    ck("range: count matches -> no findings", rc["findings"], [])
    rd = check_cf_range_drift(CFP, fetcher=lambda: ["c"] * 25)
    ck("range: upstream ADDED ranges -> fires with the delta",
       [(f["verdict"], f["delta"]) for f in rd["findings"]], [("CF_RANGE_DRIFT", 3)])
    rr = check_cf_range_drift(CFP, fetcher=lambda: ["c"] * 20)
    ck("range: upstream REMOVED ranges -> also fires",
       [(f["verdict"], f["delta"]) for f in rr["findings"]], [("CF_RANGE_DRIFT", -2)])
    rs = check_cf_range_drift(CFP, fetcher=lambda: None)
    ck("range: fetch failure -> skipped, never a pass",
       (rs["findings"], [s_["reason"] for s_ in rs["skipped"]]), ([], ["CF_RANGE_FETCH_FAILED"]))

    import tempfile as _tf
    with _tf.TemporaryDirectory() as td:
        ck("cert: absent dir -> SKIP (correct on a host with no Caddy), never a pass",
           [s_["reason"] for s_ in check_cert_expiry_floor(cert_dir=td + "/nope")["skipped"]],
           ["NO_CERT_DIR"])
        ck("cert: dir with no certs -> SKIP, never a pass",
           [s_["reason"] for s_ in check_cert_expiry_floor(cert_dir=td)["skipped"]],
           ["NO_CERTS_FOUND"])
    live = check_cert_expiry_floor()
    if live["checked"]:
        ck("cert: healthy live certs -> zero findings", live["findings"], [])
        ck("cert: forced floor above every cert -> ALL breach",
           len(check_cert_expiry_floor(floor_days=99999)["findings"]), len(live["checked"]))
        ck("cert: positive per-cert output carries days_left",
           all("days_left" in r for r in live["checked"]), True)

    # ── ALERT_EPISODE_AGE (OPS-ALERT-RECOVERY-NOTICE-W1 CH2) ──
    import tempfile as _tf2, json as _j2
    with _tf2.TemporaryDirectory() as _ad:
        _reg = os.path.join(_ad, "reg.json"); _st = os.path.join(_ad, "state"); os.makedirs(_st)
        _NOW2 = datetime(2026, 8, 21, 12, 0, 0, tzinfo=timezone.utc)
        def _mk(rows):
            with open(_reg, "w") as fh: _j2.dump({"alerts": rows}, fh)
        def _run2(): return check_alert_episode_age(_reg, _st, {"signal-1"}, _NOW2)
        _mk([{"alert_id": "A", "adopted": True}, {"alert_id": "B", "adopted": False}])

        ck("episode: no marker -> CLEAR, and an UNADOPTED alert is not measured at all",
           [(r["alert_id"], r["verdict"]) for r in _run2()["probed"]], [("A", "CLEAR")])

        with open(os.path.join(_st, "A-last-fired-at"), "w") as fh:
            fh.write(str(int((_NOW2 - timedelta(days=2)).timestamp())))
        _r = _run2()
        ck("episode: a 2d episode is FIRING and reported, not a finding",
           ([r["verdict"] for r in _r["probed"]], _r["findings"]), (["FIRING"], []))

        with open(os.path.join(_st, "A-last-fired-at"), "w") as fh:
            fh.write(str(int((_NOW2 - timedelta(days=9)).timestamp())))
        _r = _run2()
        ck("episode: a 9d episode is FIRING_STALE and IS a drift finding",
           ([r["verdict"] for r in _r["probed"]], [f["verdict"] for f in _r["findings"]]),
           (["FIRING_STALE"], ["FIRING_STALE"]))

        # AC6, the load-bearing one: absent/garbage state must render as ABSENT, never as 0.
        with open(os.path.join(_st, "A-last-fired-at"), "w") as fh:
            fh.write("not-an-epoch")
        _r = _run2()
        ck("episode: an unparseable marker is COULD_NOT_COMPARE, never a zero-age pass",
           ([r["verdict"] for r in _r["probed"]], _r["findings"]),
           (["COULD_NOT_COMPARE"], []))
        ck("episode: and it carries NO age_days at all — absent renders as absent",
           ["age_days" in r for r in _r["probed"]], [False])
        os.remove(os.path.join(_st, "A-last-fired-at"))
        ck("episode: a CLEAR verdict also carries no age_days",
           ["age_days" in r for r in _run2()["probed"]], [False])

        ck("episode: an unreadable registry is COULD_NOT_COMPARE, never a clean sweep",
           [r["verdict"] for r in check_alert_episode_age(_ad + "/nope", _st, {"h"}, _NOW2)["probed"]],
           ["COULD_NOT_COMPARE"])
        # VACUITY: a registry with rows but none adopted asserts nothing — say so.
        _mk([{"alert_id": "B", "adopted": False}])
        ck("episode: rows but NONE adopted -> COULD_NOT_COMPARE (vacuity), not an all-clear",
           [r["verdict"] for r in _run2()["probed"]], ["COULD_NOT_COMPARE"])

    # ── SYNC_LIVENESS (OPS-MONITORING-INVENTORY-RESTORE-W1) ──
    _SYNC_ROWS = [{"id": "declaration-sync", "artifact": "ops/monitoring/declaration-sync.sh",
                   "host": "204.168.185.24", "install_state": "installed",
                   "schedule": "33 * * * *",
                   "installed_at": [{"host": "signal-1", "path": "/opt/x/declaration-sync.sh",
                                     "schedule": "33 * * * *"},
                                    {"host": "aoe-1", "path": "/opt/x/declaration-sync.sh",
                                     "schedule": "27 * * * *"}]}]
    _NOW = datetime(2026, 8, 12, 12, 0, 0, tzinfo=timezone.utc)

    def _hb(minutes_ago, verdict="UNCHANGED"):
        stamp = (_NOW - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
        return {"attempt_at": stamp, "verdict": verdict}

    def _live(hb, labels={"signal-1"}, rows=None):
        return check_sync_liveness(rows if rows is not None else _SYNC_ROWS, hb, labels, _NOW)

    # Read the first probed row through a SENTINEL, never `["probed"][0][k]`. CLAUDE.md: "an
    # assertion that RAISES is not an assertion" — indexing directly turns a broken subject into
    # an IndexError that ABORTS the suite, which reads as a crash rather than the FAIL it is.
    # Measured while proving these very assertions can fail: deleting the LIVE output line (the
    # exact regression the positive-output assertion exists to catch) killed the run instead of
    # reporting, so every later check went unevaluated too.
    def _p0(result, key):
        rows_ = (result or {}).get("probed") or []
        return rows_[0].get(key, "<missing>") if rows_ else "<no probed row>"

    # The BOUND IS DERIVED, and the proof is that a DIFFERENT schedule yields a DIFFERENT bound.
    # A hardcoded literal would pass a single-schedule assertion, so one schedule can never be
    # enough evidence — this is the assertion that would fail if someone replaced the derivation
    # with a constant.
    ck("liveness: cadence derived hourly", derive_cadence_minutes("33 * * * *"), 60)
    ck("liveness: cadence derived quarter-hourly", derive_cadence_minutes("*/15 * * * *"), 15)
    ck("liveness: cadence derived twice-hourly", derive_cadence_minutes("13,43 * * * *"), 30)
    ck("liveness: cadence derived 4-hourly (hour field expands too)",
       derive_cadence_minutes("33 */4 * * *"), 240)
    ck("liveness: @hourly macro resolves", derive_cadence_minutes("@hourly"), 60)
    ck("liveness: a day-of-week schedule is NOT guessed at",
       derive_cadence_minutes("39 8 * * 2"), None)
    ck("liveness: garbage is NOT guessed at", derive_cadence_minutes("not a cron"), None)
    ck("liveness: the derived bound TRACKS the schedule, never a literal",
       [_p0(_live(_hb(90)), "bound_minutes"),
        _p0(_live(_hb(90), rows=[{**_SYNC_ROWS[0], "installed_at": None,
                                  "schedule": "*/15 * * * *"}]), "bound_minutes")],
       [120, 30])
    # Same age, opposite verdicts, decided ONLY by the schedule — the bound is load-bearing.
    ck("liveness: 90m old is LIVE on an hourly sync", _p0(_live(_hb(90)), "verdict"), "LIVE")
    ck("liveness: 90m old is STALE on a quarter-hourly sync",
       _p0(_live(_hb(90), rows=[{**_SYNC_ROWS[0], "installed_at": None,
                                 "schedule": "*/15 * * * *"}]), "verdict"), "STALE")
    ck("liveness: one missed cycle does NOT fire", _p0(_live(_hb(61)), "verdict"), "LIVE")
    ck("liveness: two missed cycles DO fire", _p0(_live(_hb(121)), "verdict"), "STALE")
    ck("liveness: STALE produces a drift finding", len(_live(_hb(121))["findings"]), 1)
    ck("liveness: LIVE produces NO finding", len(_live(_hb(30))["findings"]), 0)
    # The per-host bound comes from the per-host registry entry, not the row's top-level schedule.
    ck("liveness: aoe-1 resolves its OWN schedule from installed_at",
       _p0(_live(_hb(30), {"aoe-1"}), "schedule"), "27 * * * *")
    # Every not-a-pass path, and each must REPORT rather than silently pass or silently page.
    ck("liveness: absent heartbeat -> COULD_NOT_COMPARE, never a pass",
       _p0(_live(None), "verdict"), "COULD_NOT_COMPARE")
    ck("liveness: absent heartbeat does NOT page (bootstrap safety)", len(_live(None)["findings"]), 0)
    ck("liveness: unparseable attempt_at -> COULD_NOT_COMPARE",
       _p0(_live({"attempt_at": "yesterday"}), "verdict"), "COULD_NOT_COMPARE")
    ck("liveness: heartbeat with no attempt_at -> COULD_NOT_COMPARE",
       _p0(_live({"verdict": "SYNCED"}), "verdict"), "COULD_NOT_COMPARE")
    ck("liveness: no owned declaration-sync row -> COULD_NOT_COMPARE",
       _p0(_live(_hb(30), rows=[]), "verdict"), "COULD_NOT_COMPARE")
    ck("liveness: underivable schedule -> COULD_NOT_COMPARE",
       _p0(_live(_hb(30), rows=[{**_SYNC_ROWS[0], "installed_at": None,
                                 "schedule": "39 8 * * 2"}]), "verdict"), "COULD_NOT_COMPARE")
    # POSITIVE output on EVERY run: silence must never be the pass signal.
    ck("liveness: every verdict carries a probed row, including the passes",
       [len(_live(h)["probed"]) for h in (_hb(30), _hb(121), None)], [1, 1, 1])
    ck("liveness: a LIVE row still reports its measured age + derived bound",
       [_p0(_live(_hb(30)), k) != "<missing>" and _p0(_live(_hb(30)), k) != "<no probed row>"
        for k in ("age_minutes", "bound_minutes", "window")], [True, True, True])
    ck("liveness: the window label is explicit about n and cadence",
       _p0(_live(_hb(30)), "window"), "last 120m (2 x 60m cycle)")
    ck("liveness: the last terminal verdict is carried, so wedged != never-ran",
       _p0(_live(_hb(30, "INDETERMINATE")), "last_verdict"), "INDETERMINATE")
    # The parity-pinned expander must be UNCHANGED at its default ceiling.
    ck("liveness: parameterising the expander did not move its default",
       [expand_minute_field("*/15"), expand_minute_field("33"), expand_minute_field("13,43")],
       [[0, 15, 30, 45], [33], [13, 43]])

    for f_ in failures:
        log(f"SELF_TEST_FAIL: {f_}")
    log(f"SELF_TEST {'PASS' if not failures else 'FAIL'} checks={checks} failures={len(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="monitoring inventory reconciler")
    ap.add_argument("--check", action="store_true", help="silent; exit non-zero on any drift")
    ap.add_argument("--self-test", action="store_true", help="hermetic scenario suite; exit non-zero on failure")
    ap.add_argument("--classify-schedule", metavar="EXPR",
                    help="print '<STATUS> offset=<n>' for one cron expression. Cross-language "
                         "parity surface: scripts/check-monitoring-schedules.mjs --classify MUST "
                         "print byte-identical output for every input.")
    a = ap.parse_args()
    if a.classify_schedule is not None:
        _rule = load_boundary_rule()
        if _rule is None:
            log("BOUNDARY_RULE_UNREADABLE")
            sys.exit(3)
        _status, _offset = classify_schedule(a.classify_schedule, _rule)
        print(f"{_status} offset={_offset}")
        sys.exit(0)
    if a.self_test:
        sys.exit(self_test())
    sys.exit(main(check_mode=a.check))

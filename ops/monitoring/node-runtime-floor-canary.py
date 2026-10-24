#!/usr/bin/env python3
"""node-runtime-floor-canary — every Node runtime on this host is registered and at or above the security floor.

WHY
  CVE-2026-111497 (node:zlib Brotli out-of-bounds write) is fixed in Node 24.22.1, 22.23.4 and
  26.12.1. OPS-NODE-SECURITY-FLOOR-W1 moved every declared runtime to the fixed release of its line.
  A runtime that falls behind the newest security release of its line, or a Node binary nobody
  registered (and so nobody upgrades), is the regression this canary exists to catch.

WHAT ONE RUN CHECKS (the host named by MONITORING_HOST_LABEL, else /etc/algovault-host-label)
  enumerate  every Node runtime the host can reach: executable node/nodejs files on local disk,
             running node processes (host or container), node images, and node invocations in cron
             and systemd units. A runtime with no row in node-runtime-registry.json -> UNREGISTERED.
  measure    each registered container (docker exec node -v, every replica) and host binary
             (<path> -v): below the floor -> BEHIND; another major than the row's line ->
             LINE_MISMATCH. Exempt rows are not measured; a passed revisit_by -> EXEMPTION_EXPIRED.
  floor      the producer's record, https://nodejs.org/dist/index.json: the newest security:true
             release per major. On the registry's floor_check_host the committed floor file is read
             from origin/main with a cache-buster: live floor newer -> FLOOR_FILE_BEHIND; its revisit_by
             within 7 days -> FLOOR_FILE_EXPIRING. The effective floor is the newer of the two.
  aoe-1 has no measured rows, so it is enumeration only and makes no network call.

ALERT (severity: CRITICAL_PERSISTENT, through send_telegram.sh page-on-change)
  NODE_RUNTIME_BEHIND on any FAIL. ALERT_KEYS: behind:<floor>, overdue:<floor> (72 h after the floor
  release's index date), floor-file:<v>, floor-file-revisit:<date>, unregistered:<host>:<ref>,
  line-mismatch:<id>:<major>, exemption-expired:<id>. At most 2 pages per release.
  NODE_RUNTIME_FLOOR_INDETERMINATE on the 3rd consecutive INDETERMINATE day (key since:<date>).
  PASS clears both. Nothing is sent on completion.

RECORD  canary_result_log.append_result("node_runtime_floor", verdict, exit_code, metrics)

Verdict: NODE_RUNTIME_FLOOR_VERDICT=PASS|FAIL|INDETERMINATE, exit 0 / 1 / 3. FAIL > INDETERMINATE > PASS.

Install: ops/scripts/install-monitoring-artifact.sh node-runtime-floor-canary (timestamped backup).
Cron (root crontab):
  signal-1  flock -n /var/lock/node-runtime-floor-canary.lock /usr/bin/python3 <host_path> >> /var/log/algovault-node-runtime-floor-canary.log 2>&1
  aoe-1     MONITORING_HOST_LABEL=aoe-1 /usr/bin/python3 <host_path> >> /var/log/algovault-monitoring/node-runtime-floor-canary.log 2>&1

--self-test               hermetic: every verdict class, the parsers, the paging plan.
--dry-run                 every leg and the verdict; no page, clear, state write or record.
--derive-floor <file>     the floor this canary derives from a saved index (the JS parity test).

Env: NODE_RUNTIME_ROOT (/), NODE_RUNTIME_INDEX_URL, NODE_RUNTIME_FLOOR_URL, NODE_RUNTIME_FLOOR_STATE,
     NODE_RUNTIME_REGISTRY (the sibling node-runtime-registry.json), TG_WRAPPER,
     CANARY_RESULT_LOG_PATH, MONITORING_HOST_LABEL.
"""
from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

CANARY = "node_runtime_floor"
LOG_NAME = "node-runtime-floor-canary"
TOKEN = "NODE_RUNTIME_FLOOR_VERDICT"
CODES = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
HOSTS = ("signal-1", "aoe-1")

ROOT = os.environ.get("NODE_RUNTIME_ROOT", "/")
INDEX_URL = os.environ.get("NODE_RUNTIME_INDEX_URL", "https://nodejs.org/dist/index.json")
FLOOR_URL = os.environ.get(
    "NODE_RUNTIME_FLOOR_URL",
    "https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/scripts/data/node-security-floor.json",
)
STATE_PATH = os.environ.get("NODE_RUNTIME_FLOOR_STATE", "/var/lib/algovault-monitoring/node-runtime-floor-canary-state.json")
REGISTRY_PATH = os.environ.get("NODE_RUNTIME_REGISTRY", str(Path(__file__).resolve().parent / "node-runtime-registry.json"))
WRAPPER = os.environ.get("TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
TG = WRAPPER  # noqa: N806 — the two paging argvs name their alert right beside it

BEHIND_WAVE = "OPS-NODE-SECURITY-FLOOR-W{NEXT}"
IND_WAVE = "OPS-NODE-RUNTIME-FLOOR-CANARY-W{NEXT}"

# Mirrors scripts/check-runtime-node-security.mjs (REVISIT_DAYS, MIN_MAJOR, MIN_INDEX_ROWS, MIN_NEWEST_MAJOR).
REVISIT_DAYS = 45
EXPIRY_WARNING_DAYS = 7
MIN_MAJOR = 18
MIN_INDEX_ROWS = 100
MIN_NEWEST_MAJOR = 24
OVERDUE_HOURS = 72
IND_PAGE_AFTER_DAYS = 2  # since + 2 days = the 3rd consecutive INDETERMINATE day
MAX_KEYS = 100
BODY_CAP = 3800

NODE_NAMES = ("node", "nodejs")
NODEISH = NODE_NAMES + ("npm", "npx", "corepack", "yarn", "pnpm")
NODEISH_RE = re.compile(r"(?<![\w.-])(?:node|nodejs|npm|npx|corepack|yarn|pnpm)(?![\w.-])", re.ASCII)


def now_utc():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg):
    print(f"{iso(now_utc())} [{LOG_NAME}] {msg}", flush=True)


# ── pure helpers ─────────────────────────────────────────────────────────────────────────────

VERSION_RE = re.compile(r"v?(\d+)\.(\d+)\.(\d+)", re.ASCII)
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)
KEY_CHARS = "A-Za-z0-9._:|/@+-"
KEY_RE = re.compile(r"[A-Za-z0-9][%s]{0,127}" % KEY_CHARS, re.ASCII)
ID_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}", re.ASCII)


def parse_version(s):
    m = VERSION_RE.fullmatch(s) if isinstance(s, str) else None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def vstr(v):
    return ".".join(str(x) for x in v)


def parse_date(s):
    if not isinstance(s, str) or not DATE_RE.fullmatch(s):
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def days_until(date_str, now):
    # Parity with daysUntil() in the gate: whole days (floored) from now to 00:00Z of date_str.
    d = parse_date(date_str)
    return None if d is None else int((d - now).total_seconds() // 86400)


def add_days(date_str, days):
    return (parse_date(date_str) + timedelta(days=days)).strftime("%Y-%m-%d")


def make_key(raw):
    s = re.sub(r"[^%s]" % KEY_CHARS, "_", raw).lstrip("._:|/@+-") or "key"
    if len(s) > 128:
        s = s[:117] + "-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:10]
    return s


# ── registry ─────────────────────────────────────────────────────────────────────────────────

KINDS = {"container": "docker-exec", "host-binary": "exec-version", "image": "none", "ci-floating": "none", "dev": "none"}
ROW_HOSTS = ("signal-1", "aoe-1", "ci", "mac")


def _row_problem(r):
    kind, m, ex = r.get("kind"), r.get("match"), r.get("exempt")
    if r.get("host") not in ROW_HOSTS:
        return "an unknown host %r" % (r.get("host"),)
    if kind not in KINDS:
        return "an unknown kind %r" % (kind,)
    if r.get("measure") != KINDS[kind]:
        return "kind %s with measure %r (a %s row measures %s)" % (kind, r.get("measure"), kind, KINDS[kind])
    if type(r.get("line")) is not int or r["line"] < 1:
        return "no integer line"
    if "exempt" in r and not (
        isinstance(ex, dict) and isinstance(ex.get("reason"), str) and ex["reason"].strip()
        and parse_date(ex.get("revisit_by")) is not None
    ):
        return "a malformed exempt (want reason + revisit_by YYYY-MM-DD)"
    if kind == "container" and not (
        isinstance(m, dict) and all(isinstance(m.get(k), str) and m[k] for k in ("compose_project", "compose_service"))
    ):
        return "no match.compose_project + match.compose_service"
    if kind == "host-binary" and not (isinstance(r.get("path"), str) and r["path"].startswith("/")):
        return "no absolute path"
    if kind == "image" and not (isinstance(m, dict) and isinstance(m.get("image"), str) and m["image"]):
        return "no match.image"
    if kind == "ci-floating" and not all(isinstance(r.get(k), str) and r[k] for k in ("workflow", "node_version")):
        return "no workflow + node_version"
    return None


def validate_registry(doc, host):
    # -> (registry, None) | (None, reason). A broken registry stops the run INDETERMINATE: judging
    # what was enumerated against it would report registered runtimes as UNREGISTERED.
    if not isinstance(doc, dict) or not isinstance(doc.get("runtimes"), list) or not doc["runtimes"]:
        return None, "the registry has no `runtimes` rows"
    floor_host = doc.get("floor_check_host")
    if floor_host not in HOSTS:
        return None, "the registry's floor_check_host %r is not signal-1 or aoe-1" % (floor_host,)
    seen, rows = set(), []
    for i, r in enumerate(doc["runtimes"]):
        rid = r.get("id") if isinstance(r, dict) else None
        if not isinstance(rid, str) or not ID_RE.fullmatch(rid):
            return None, "registry row %d has no valid id" % i
        if rid in seen:
            return None, "registry row %s is a duplicate id" % rid
        seen.add(rid)
        bad = _row_problem(r)
        if bad:
            return None, "registry row %s has %s" % (rid, bad)
        rows.append(r)
    mine = [r for r in rows if r["host"] == host]
    if not mine:
        return None, "the registry has zero rows for host %s" % host
    return {"rows": rows, "mine": mine, "floor_check_host": floor_host}, None


def host_label(root):
    v, src = os.environ.get("MONITORING_HOST_LABEL", "").strip(), "MONITORING_HOST_LABEL"
    if not v:
        src = "/etc/algovault-host-label"
        try:
            with open(rooted(root, src), encoding="utf-8") as f:
                v = f.read().strip()
        except OSError:
            v = ""
    if v not in HOSTS:
        return None, "the host label %r (from %s) is not signal-1 or aoe-1, so no registry rows can be chosen" % (v, src)
    return v, None


# ── a root-confined view of the filesystem (NODE_RUNTIME_ROOT is the self-test's seam) ────────

def rooted(root, hp):
    r = root.rstrip("/")
    return (r + hp) if r else hp


def unrooted(root, p):
    r = root.rstrip("/")
    if r and (p == r or p.startswith(r + "/")):
        return p[len(r):] or "/"
    return p


def resolve_in_root(root, hp, limit=40):
    # Follow the symlinks of host path `hp` without leaving `root`: an absolute target is re-rooted,
    # a relative one resolves against its own directory. -> final host path, None on a loop/bad link.
    todo, done, hops = [c for c in hp.split("/") if c], [], 0
    while todo:
        c = todo.pop(0)
        if c == ".":
            continue
        if c == "..":
            if done:
                done.pop()
            continue
        real = rooted(root, "/" + "/".join(done + [c]))
        try:
            st = os.lstat(real)
        except OSError:
            done.append(c)
            continue
        if not stat.S_ISLNK(st.st_mode):
            done.append(c)
            continue
        hops += 1
        if hops > limit:
            return None
        try:
            target = os.readlink(real)
        except OSError:
            return None
        if target.startswith("/"):
            target, done = unrooted(root, target), []
        todo = [x for x in target.split("/") if x] + todo
    return "/" + "/".join(done)


def is_exec_file(path):
    try:
        st = os.stat(path)
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode) and bool(st.st_mode & 0o111)


# ── leg a: node binaries on local disk ───────────────────────────────────────────────────────

PRUNE = ("/proc", "/sys", "/dev", "/run", "/var/lib/docker", "/var/lib/containerd")
LOCAL_FS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "jfs", "reiserfs", "tmpfs"}


def foreign_mounts(root):
    # Mount points of anything but local disk / tmpfs (vfat, nfs, fuse, overlay, squashfs, ...).
    out = set()
    try:
        with open(rooted(root, "/proc/self/mounts"), encoding="utf-8", errors="replace") as f:
            for line in f:
                p = line.split()
                if len(p) >= 3 and p[2] not in LOCAL_FS:
                    out.add(re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), p[1]))
    except OSError:
        pass
    return out


def walk_disk(root):
    # -> ({final host path: [names that reach it]}, errors, counts)
    pruned = (set(PRUNE) | foreign_mounts(root)) - {"/"}
    found, errors, counts = {}, [], {"disk_dirs": 0, "disk_files": 0}

    def onerror(e):
        if e.errno in (errno.EACCES, errno.EPERM):
            errors.append("the disk walk cannot read %s (%s)" % (unrooted(root, e.filename or "?"), e.strerror))

    for dirpath, dirnames, filenames in os.walk(rooted(root, "/"), onerror=onerror):
        hdir = unrooted(root, dirpath).rstrip("/")
        counts["disk_dirs"] += 1
        counts["disk_files"] += len(filenames)
        dirnames[:] = [d for d in dirnames if (hdir + "/" + d) not in pruned]
        for n in filenames:
            if n not in NODE_NAMES:
                continue
            hp = hdir + "/" + n
            final = resolve_in_root(root, hp)
            if final is None:
                errors.append("the disk walk cannot resolve the symlink chain at %s" % hp)
            elif is_exec_file(rooted(root, final)):
                found.setdefault(final, []).append(hp)
    counts["disk_node_binaries"] = len(found)
    return found, errors, counts


# ── leg b: running node processes ────────────────────────────────────────────────────────────

CGROUP_DOCKER_RE = re.compile(r"docker[-/]([0-9a-f]{64})", re.ASCII)


def scan_processes(root):
    # -> ([{"pid", "exe", "cid", "ino"}], errors, number of pids listed). cid None = a host process.
    procdir = rooted(root, "/proc")
    out, errors = [], []
    try:
        pids = sorted((p for p in os.listdir(procdir) if p.isdigit()), key=int)
    except OSError as e:
        return [], ["cannot list /proc (%s)" % e.strerror], 0
    for pid in pids:
        base = os.path.join(procdir, pid)
        try:
            exe = unrooted(root, os.readlink(os.path.join(base, "exe")))
        except OSError as e:
            if e.errno in (errno.EACCES, errno.EPERM):
                errors.append("cannot read /proc/%s/exe (%s)" % (pid, e.strerror))
            continue
        if exe.endswith(" (deleted)"):
            exe = exe[: -len(" (deleted)")]
        if os.path.basename(exe) not in NODE_NAMES:
            continue
        try:
            with open(os.path.join(base, "cgroup"), encoding="utf-8", errors="replace") as f:
                m = CGROUP_DOCKER_RE.search(f.read())
            st = os.stat(os.path.join(base, "exe"))
        except OSError as e:
            if e.errno in (errno.EACCES, errno.EPERM):
                errors.append("cannot read /proc/%s (%s)" % (pid, e.strerror))
            continue
        out.append({"pid": int(pid), "exe": exe, "cid": m.group(1) if m else None, "ino": (st.st_dev, st.st_ino)})
    return out, errors, len(pids)


def run(argv, timeout, env=None):
    # -> (returncode, stdout, stderr); returncode None when it could not run or timed out
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return None, "", "timed out after %d s" % timeout
    except OSError as e:
        return None, "", str(e)[:160]


def _why(rc, out, err):
    return ((err or "").strip() or (out or "").strip() or "rc=%s" % rc).splitlines()[0][:140]


class Docker:
    # Every docker call this canary makes. bin None = docker is absent (the self-test passes None).
    INSPECT_FMT = '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.Config.Image}}'

    def __init__(self, bin_path):
        self.bin = bin_path
        self.cache = {}

    def inspect(self, ref):
        # container name / id -> {"project", "service", "image"} | {"error"}
        if ref not in self.cache:
            if not self.bin:
                r = {"error": "docker is not on PATH"}
            else:
                rc, out, err = run([self.bin, "inspect", "--type", "container", "--format", self.INSPECT_FMT, ref], 20)
                parts = [("" if x == "<no value>" else x) for x in out.strip().split("|")]
                if rc != 0 or len(parts) != 3:
                    r = {"error": "docker inspect %s failed (%s)" % (ref[:40], _why(rc, out, err))}
                else:
                    r = {"project": parts[0], "service": parts[1], "image": parts[2]}
            self.cache[ref] = r
        return self.cache[ref]

    def node_images(self):
        rc, out, err = run([self.bin, "images", "--format", "{{.Repository}}|{{.Tag}}|{{.ID}}"], 30)
        if rc != 0:
            return None, "docker images failed (%s)" % _why(rc, out, err)
        refs = set()
        for line in out.splitlines():
            p = line.strip().split("|")
            if len(p) == 3 and (p[0] == "node" or p[0].endswith("/node")):
                refs.add("%s:%s" % (p[0], p[1]) if p[1] and p[1] != "<none>" else "%s@%s" % (p[0], p[2]))
        return sorted(refs), None

    def measure(self, project, service):
        # node -v in every running replica of a compose service -> ([versions], None) | (None, reason)
        if not self.bin:
            return None, "docker is not on PATH"
        rc, out, err = run([self.bin, "ps", "--filter", "label=com.docker.compose.project=" + project,
                            "--filter", "label=com.docker.compose.service=" + service, "--format", "{{.ID}}"], 20)
        if rc != 0:
            return None, "docker ps failed (%s)" % _why(rc, out, err)
        ids = out.split()
        if not ids:
            return None, "no running replica of %s/%s" % (project, service)
        vs = []
        for cid in ids:
            rc, out, err = run([self.bin, "exec", cid, "node", "-v"], 20)
            if rc != 0 or parse_version(out.strip()) is None:
                return None, "docker exec %s node -v printed no version (%s)" % (cid[:12], _why(rc, out, err))
            vs.append(out.strip())
        return vs, None


def measure_host(root, path):
    final = resolve_in_root(root, path)
    if not final or not is_exec_file(rooted(root, final)):
        return None, "%s is not an executable file on this host" % path
    rc, out, err = run([rooted(root, final), "-v"], 10, env={"PATH": "/usr/bin:/bin"})
    if rc != 0 or parse_version(out.strip()) is None:
        return None, "%s -v printed no version (%s)" % (path, _why(rc, out, err))
    return [out.strip()], None


# ── leg d sources: cron tables and systemd units ─────────────────────────────────────────────
# A job is (src, command, PATH, cwd, argv0_skip).

CRON_PATH = "/usr/bin:/bin"
SYSTEMD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
UNIT_DIRS = ("/etc/systemd/system", "/run/systemd/system", "/usr/local/lib/systemd/system",
             "/usr/lib/systemd/system", "/lib/systemd/system")
EXEC_RE = re.compile(r"(Exec(?:Start|StartPre|StartPost|Condition|Reload|Stop|StopPost))\s*=\s*(.*)", re.ASCII | re.DOTALL)
CRON_D_NAME_RE = re.compile(r"[A-Za-z0-9_-]+", re.ASCII)


def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def home_dirs(root):
    homes = {}
    try:
        for line in read_text(rooted(root, "/etc/passwd")).splitlines():
            p = line.split(":")
            if len(p) >= 6 and p[5].startswith("/"):
                homes[p[0]] = p[5]
    except OSError:
        pass
    return homes


def cron_command(s):
    # cron: the first unescaped % ends the command (the rest is its stdin); \% is a literal %
    out, i = [], 0
    while i < len(s):
        if s[i] == "\\" and s[i + 1:i + 2] == "%":
            out.append("%")
            i += 2
            continue
        if s[i] == "%":
            break
        out.append(s[i])
        i += 1
    return "".join(out)


def cron_jobs(text, has_user, src, homes, owner="root"):
    jobs, path = [], CRON_PATH
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if re.match(r"[A-Za-z_]", line):
            m = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)", line)
            if m and m.group(1) == "PATH":
                path = m.group(2).strip().strip("'\"")
            continue
        nf = (1 if line.startswith("@") else 5) + (1 if has_user else 0)
        parts = line.split(None, nf)
        if len(parts) <= nf:
            continue
        user = parts[nf - 1] if has_user else owner
        jobs.append(("%s:%d" % (src, n), cron_command(parts[nf]), path, homes.get(user, "/"), False))
    return jobs


def _listdir(root, d, errors):
    try:
        return sorted(os.listdir(rooted(root, d)))
    except FileNotFoundError:
        return []
    except OSError as e:
        errors.append("cannot list %s (%s)" % (d, e.strerror))
        return []


def cron_sources(root, homes):
    jobs, errors, files = [], [], 0
    specs = [("/etc/crontab", True, "root")]
    specs += [("/etc/cron.d/" + n, True, "root") for n in _listdir(root, "/etc/cron.d", errors) if CRON_D_NAME_RE.fullmatch(n)]
    spool = "/var/spool/cron/crontabs"
    specs += [(spool + "/" + n, False, n) for n in _listdir(root, spool, errors) if not n.startswith(".")]
    for hp, has_user, owner in specs:
        try:
            text = read_text(rooted(root, hp))
        except (FileNotFoundError, IsADirectoryError):
            continue
        except OSError as e:
            errors.append("cannot read %s (%s)" % (hp, e.strerror))
            continue
        files += 1
        jobs += cron_jobs(text, has_user, hp, homes, owner)
    return jobs, errors, files


def unit_exec_lines(text, src):
    logical, buf, start = [], "", 0
    for n, raw in enumerate(text.splitlines(), 1):
        if not buf:
            start = n
        if raw.endswith("\\"):
            buf += raw[:-1] + " "
            continue
        logical.append((start, buf + raw))
        buf = ""
    if buf:
        logical.append((start, buf))
    cwd = "/"
    for _, line in logical:
        m = re.fullmatch(r"\s*WorkingDirectory\s*=\s*-?(/\S*)\s*", line)
        if m:
            cwd = m.group(1)
    jobs = []
    for n, line in logical:
        m = EXEC_RE.fullmatch(line.strip())
        if not m or not m.group(2).strip():
            continue  # an empty ExecStart= only resets the list
        val, skip0 = m.group(2).strip(), False
        while val[:1] and val[0] in "@-:+!":
            skip0 = skip0 or val[0] == "@"
            val = val[1:]
        jobs.append(("%s:%d" % (src, n), val, SYSTEMD_PATH, cwd, skip0))
    return jobs


def unit_sources(root):
    jobs, errors, files, seen = [], [], 0, set()
    for d in UNIT_DIRS:
        base = rooted(root, d)
        real = os.path.realpath(base)
        if real in seen or not os.path.isdir(base):
            continue
        seen.add(real)
        paths = []
        for n in _listdir(root, d, errors):
            if n.endswith(".service"):
                paths.append(d + "/" + n)
            elif n.endswith(".service.d"):
                paths += [d + "/" + n + "/" + c for c in _listdir(root, d + "/" + n, errors) if c.endswith(".conf")]
        for hp in paths:
            try:
                text = read_text(rooted(root, hp))
            except (FileNotFoundError, IsADirectoryError):
                continue
            except OSError as e:
                errors.append("cannot read %s (%s)" % (hp, e.strerror))
                continue
            files += 1
            jobs += unit_exec_lines(text, hp)
    return jobs, errors, files


# ── leg d parser: which runtime does a command line invoke? ──────────────────────────────────
# A ref is ("host", path, src) | ("container", name, src) | ("image", image, src) | ("ind", reason).

OP_CHARS = set("();<>|&")
RESERVED = {"if", "then", "else", "elif", "fi", "do", "done", "while", "until", "{", "}", "!", "esac", "in"}
COMPOUND = {"for", "case", "select"}
SHELLS = {"sh", "bash", "dash", "zsh", "ksh"}
ASSIGN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*", re.ASCII | re.DOTALL)
# wrapper -> (options that take a value, positional words before the wrapped command)
WRAPPERS = {
    "nohup": ((), 0), "chronic": ((), 0), "setsid": ((), 0), "exec": (("-a",), 0),
    "nice": (("-n", "--adjustment"), 0),
    "ionice": (("-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"), 0),
    "stdbuf": (("-i", "-o", "-e", "--input", "--output", "--error"), 0),
    "timeout": (("-k", "--kill-after", "-s", "--signal"), 1),
    "time": (("-f", "--format", "-o", "--output"), 0),
    "sudo": (("-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host", "-p",
              "--prompt", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout"), 0),
}
DOCKER_GLOBAL_ARG = {"--config", "-c", "--context", "-H", "--host", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"}
DOCKER_EXEC_ARG = {"-e", "--env", "--env-file", "-u", "--user", "-w", "--workdir", "--detach-keys"}
DOCKER_RUN_ARG = {
    "-a", "--attach", "--add-host", "--annotation", "--blkio-weight", "--cap-add", "--cap-drop", "--cgroup-parent",
    "--cgroupns", "--cidfile", "--cpu-period", "--cpu-quota", "--cpu-shares", "-c", "--cpus", "--cpuset-cpus",
    "--cpuset-mems", "--device", "--dns", "--dns-option", "--dns-search", "--domainname", "--entrypoint", "-e",
    "--env", "--env-file", "--expose", "--gpus", "--group-add", "--health-cmd", "--health-interval",
    "--health-retries", "--health-start-period", "--health-timeout", "-h", "--hostname", "--ip", "--ip6", "--ipc",
    "--isolation", "-l", "--label", "--label-file", "--link", "--log-driver", "--log-opt", "--mac-address", "-m",
    "--memory", "--memory-reservation", "--memory-swap", "--memory-swappiness", "--mount", "--name", "--network",
    "--net", "--network-alias", "--pid", "--pids-limit", "--platform", "-p", "--publish", "--pull", "--restart",
    "--runtime", "--security-opt", "--shm-size", "--stop-signal", "--stop-timeout", "--storage-opt", "--sysctl",
    "--tmpfs", "--ulimit", "-u", "--user", "--userns", "--uts", "-v", "--volume", "--volumes-from", "-w", "--workdir",
}
DOCKER_RUN_FLAGS = {"--detach", "--interactive", "--tty", "--rm", "--init", "--privileged", "--read-only",
                    "--publish-all", "--no-healthcheck", "--oom-kill-disable", "--sig-proxy", "--quiet",
                    "--disable-content-trust"}


def split_commands(cmd):
    # -> simple commands (word lists). Redirects and their targets are dropped; `...` is split out
    # and analysed as its own commands. Raises ValueError on unbalanced quotes.
    ticks = re.findall(r"`([^`]*)`", cmd)
    lex = shlex.shlex(re.sub(r"`[^`]*`", " ", cmd), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    toks = list(lex)
    out, cur, i = [], [], 0

    def is_op(t):
        return bool(t) and all(ch in OP_CHARS for ch in t)

    def is_redirect(t):
        return is_op(t) and ("<" in t or ">" in t)

    while i < len(toks):
        t = toks[i]
        if is_op(t):
            if any(ch in ";|()" for ch in t) or set(t) == {"&"}:
                if cur:
                    out.append(cur)
                cur = []
            i += 2 if is_redirect(t) else 1
            continue
        if t.isdigit() and i + 1 < len(toks) and is_redirect(toks[i + 1]):
            i += 1  # the fd number of a redirect such as 2>&1
            continue
        cur.append(t)
        i += 1
    if cur:
        out.append(cur)
    for t in ticks:
        out += split_commands(t)
    return out


def take_opts(words, arg_opts):
    i = 0
    while i < len(words):
        w = words[i]
        if w == "--":
            return words[i + 1:]
        if not w.startswith("-") or w == "-":
            break
        i += 2 if w in arg_opts else 1
    return words[i:]


def unwrap(words, ctx):
    # -> ("words", argv) after a wrapper | ("shell", string) | ("skip", None) | ("final", argv)
    w0, rest = os.path.basename(words[0]), words[1:]
    if w0 == "env":
        i = 0
        while i < len(rest):
            w = rest[i]
            if w.startswith("-S") or w == "--split-string":
                s = w[2:].strip() if w.startswith("-S") and len(w) > 2 else (rest[i + 1] if i + 1 < len(rest) else "")
                tail = rest[i + 1:] if w.startswith("-S") and len(w) > 2 else rest[i + 2:]
                return "words", shlex.split(s) + tail
            if w in ("-u", "--unset", "-C", "--chdir"):
                i += 2
            elif w.startswith("-") or ASSIGN_RE.fullmatch(w):
                i += 1
            else:
                break
        return ("words", rest[i:]) if rest[i:] else ("skip", None)
    if w0 == "flock":
        r = take_opts(rest, {"-w", "--wait", "--timeout", "-E", "--conflict-exit-code"})[1:]
        if r[:1] in (["-c"], ["--command"]):
            return "shell", (r[1] if len(r) > 1 else "")
        return ("words", r) if r else ("skip", None)
    if w0 == "command":
        if any(w in ("-v", "-V") for w in rest[:2]):
            return "skip", None
        r = take_opts(rest, set())
        return ("words", r) if r else ("skip", None)
    if w0 in ("su", "runuser"):
        for i, w in enumerate(rest):
            if w in ("-c", "--command") and i + 1 < len(rest):
                return "shell", rest[i + 1]
            if w.startswith("--command="):
                return "shell", w[len("--command="):]
        if w0 == "runuser" and "-u" in rest:
            r = rest[rest.index("-u") + 2:]
            r = r[1:] if r[:1] == ["--"] else r
            return ("words", r) if r else ("skip", None)
        return "skip", None
    if w0 in SHELLS:
        i, has_c = 0, False
        while i < len(rest) and rest[i][:1] in ("-", "+") and rest[i] not in ("-", "--"):
            w = rest[i]
            if w in ("-o", "+o", "-O", "+O", "--rcfile", "--init-file"):
                i += 2
                continue
            has_c = has_c or (not w.startswith("--") and "c" in w[1:])
            i += 1
        # a script file or an interactive shell is not followed
        return ("shell", rest[i]) if has_c and i < len(rest) else ("skip", None)
    if w0 in WRAPPERS:
        arg_opts, npos = WRAPPERS[w0]
        r = take_opts(rest, set(arg_opts))[npos:]
        return ("words", r) if r else ("skip", None)
    return "final", words


def image_repo(image):
    name = image.split("@", 1)[0]
    return name[:name.rfind(":")] if name.rfind(":") > name.rfind("/") else name


def docker_refs(args, src):
    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 2 if args[i] in DOCKER_GLOBAL_ARG else 1
    args = args[i:]
    if args[:1] == ["container"]:
        args = args[1:]
    if not args:
        return []
    sub, rest = args[0], args[1:]
    if sub == "compose":
        if NODEISH_RE.search(" ".join(rest)) and any(w in ("exec", "run") for w in rest):
            return [("ind", "%s runs node through docker compose exec/run, which names no container" % src)]
        return []
    if sub == "exec":
        r = take_opts(rest, DOCKER_EXEC_ARG)
        return [("container", r[0], src)] if len(r) >= 2 and NODEISH_RE.search(" ".join(r[1:])) else []
    if sub != "run":
        return []
    i = 0
    while i < len(rest) and rest[i].startswith("-") and rest[i] != "-":
        w = rest[i]
        if w == "--":
            i += 1
            break
        if w.startswith("--") and "=" in w or w in DOCKER_RUN_FLAGS or re.fullmatch(r"-[ditPq]+", w):
            i += 1
        elif w in DOCKER_RUN_ARG:
            i += 2
        else:
            if NODEISH_RE.search(" ".join(rest)):
                return [("ind", "%s passes docker run the unknown option %s, so its image cannot be found" % (src, w))]
            return []
    if i >= len(rest):
        return []
    image = rest[i]
    repo = image_repo(image)
    if repo == "node" or repo.endswith("/node") or NODEISH_RE.search(" ".join(rest[i + 1:])):
        return [("image", image, src)]
    return []


def which(root, word, path, cwd):
    # -> the resolved host path of an executable command word, or None
    if "/" in word:
        cands = [word if word.startswith("/") else os.path.normpath(os.path.join(cwd, word))]
    else:
        cands = [d.rstrip("/") + "/" + word for d in path.split(":") if d.startswith("/")]
    for c in cands:
        final = resolve_in_root(root, c)
        if final and is_exec_file(rooted(root, final)):
            return final
    return None


def shebang_node(root, hp, path):
    # -> the node interpreter a script's #! names (directly or through env), "" when it names none,
    # None when it names node but no such interpreter exists
    try:
        with open(rooted(root, hp), "rb") as f:
            head = f.read(256)
    except OSError:
        return ""
    if not head.startswith(b"#!"):
        return ""
    line = head[2:].split(b"\n", 1)[0].decode("utf-8", "replace").strip()
    parts = line.split(None, 1)
    if not parts:
        return ""
    interp, arg = parts[0], (parts[1] if len(parts) > 1 else "")
    if os.path.basename(interp) in NODE_NAMES:
        final = resolve_in_root(root, interp)
        return final if final and is_exec_file(rooted(root, final)) else None
    if os.path.basename(interp) != "env":
        return ""
    words = arg.split()
    while words and (words[0].startswith("-") or ASSIGN_RE.fullmatch(words[0])):
        words = ([words[0][2:]] if words[0].startswith("-S") and len(words[0]) > 2 else []) + words[1:]
    if words and os.path.basename(words[0]) in NODE_NAMES:
        return which(root, words[0], path, "/")
    return ""


def classify_final(words, ctx):
    w0, src = words[0], ctx["src"]
    b = os.path.basename(w0)
    if b == "docker":
        return docker_refs(words[1:], src)
    if b == "docker-compose":
        if NODEISH_RE.search(" ".join(words[1:])) and any(w in ("exec", "run") for w in words[1:]):
            return [("ind", "%s runs node through docker-compose exec/run, which names no container" % src)]
        return []
    hp = which(ctx["root"], w0, ctx["path"], ctx["cwd"])
    if b in NODE_NAMES:
        return [("host", hp, src)] if hp else [("ind", "%s invokes %s, which is not on its PATH %s" % (src, w0, ctx["path"]))]
    if not hp:
        return []
    interp = shebang_node(ctx["root"], hp, ctx["path"])
    if interp is None:
        return [("ind", "%s runs %s, whose #! names a node that is not on this host" % (src, hp))]
    return [("host", interp, src)] if interp else []


def analyze(cmd, ctx, depth=0):
    # -> the refs a command string invokes. ctx: root, path, cwd, src, argv0_skip.
    if depth > 6:
        return [("ind", "%s nests shells deeper than 6 levels" % ctx["src"])] if NODEISH_RE.search(cmd) else []
    try:
        cmds = split_commands(cmd)
    except ValueError as e:
        return [("ind", "%s cannot be parsed (%s)" % (ctx["src"], e))] if NODEISH_RE.search(cmd) else []
    if ctx.get("argv0_skip") and cmds and len(cmds[0]) > 1:
        del cmds[0][1]  # systemd @: the second word is argv[0], not an argument
    ctx = dict(ctx, argv0_skip=False)
    refs = []
    for words in cmds:
        sub = dict(ctx)
        try:
            while words:
                while words and (words[0] in RESERVED or ASSIGN_RE.fullmatch(words[0])):
                    if words[0].startswith("PATH="):
                        sub["path"] = words[0][5:].replace("${PATH}", sub["path"]).replace("$PATH", sub["path"])
                    words = words[1:]
                if not words:
                    ctx["path"] = sub["path"]  # a bare PATH=... persists for the rest of the line
                    break
                if words[0] in COMPOUND:
                    break
                if words[0] == "cd":
                    if len(words) > 1:
                        ctx["cwd"] = os.path.normpath(os.path.join(ctx["cwd"], words[1]))
                    break
                kind, payload = unwrap(words, sub)
                if kind == "words":
                    words = payload
                    continue
                if kind == "shell":
                    refs += analyze(payload, sub, depth + 1)
                elif kind == "final":
                    refs += classify_final(payload, sub)
                break
        except ValueError as e:
            if NODEISH_RE.search(" ".join(words)):
                refs.append(("ind", "%s cannot be parsed (%s)" % (ctx["src"], e)))
    return refs


# ── the floor ────────────────────────────────────────────────────────────────────────────────

def floor_from_index(rows):
    # Exact mirror of floorFromIndex() in scripts/check-runtime-node-security.mjs; a parity test pins it.
    if not isinstance(rows, list):
        return {"ok": False, "reason": "the index is not an array"}
    lines, parsed, security = {}, 0, 0
    for r in rows:
        v = parse_version(r.get("version")) if isinstance(r, dict) else None
        if not v:
            continue
        parsed += 1
        if v[0] < MIN_MAJOR:
            continue
        if type(r.get("security")) is not bool:
            return {"ok": False, "reason": "index row %s has no boolean `security` field" % r["version"]}
        lines.setdefault(v[0], None)
        if not r["security"]:
            continue
        if not (isinstance(r.get("date"), str) and DATE_RE.fullmatch(r["date"])):
            return {"ok": False, "reason": "index row %s has no valid date" % r["version"]}
        security += 1
        cur = lines[v[0]]
        if cur is None or v > cur[0]:
            lines[v[0]] = (v, r["date"])
    if parsed < MIN_INDEX_ROWS:
        return {"ok": False, "reason": "the index has %d release rows (< %d)" % (parsed, MIN_INDEX_ROWS)}
    if security == 0:
        return {"ok": False, "reason": "the index marks no release as security"}
    majors = sorted(lines)
    if not majors or majors[-1] < MIN_NEWEST_MAJOR:
        return {"ok": False, "reason": "the index knows no line at or above %d" % MIN_NEWEST_MAJOR}
    floor = {}
    for M in majors:
        x = lines[M]
        floor[str(M)] = {"version": vstr(x[0]), "date": x[1]} if x else {"version": None, "date": None}
    return {"ok": True, "floor": floor}


def floor_table(floor):
    # {"24": {"version", "date"}} -> {24: ((24, 22, 1), date) | None}
    return {int(M): ((parse_version(x["version"]), x["date"]) if x["version"] else None) for M, x in floor.items()}


def parse_floor_file(raw, now):
    # loadFloor() of the gate minus its STALE refusal: staleness is this canary's FLOOR_FILE_EXPIRING.
    try:
        d = json.loads(raw)
    except ValueError as e:
        return {"ok": False, "reason": "the floor file is unparseable (%s)" % str(e)[:120]}
    rows = d.get("floor") if isinstance(d, dict) else None
    if not isinstance(rows, dict) or not rows:
        return {"ok": False, "reason": "the floor file has no `floor` rows"}
    floor = {}
    for major, row in rows.items():
        if not re.fullmatch(r"\d+", major, re.ASCII) or not isinstance(row, dict):
            return {"ok": False, "reason": "floor row %s is malformed" % major}
        if "version" in row and "date" in row and row["version"] is None and row["date"] is None:
            floor[int(major)] = None
            continue
        v = parse_version(row.get("version"))
        if not v or v[0] != int(major) or not (isinstance(row.get("date"), str) and DATE_RE.fullmatch(row["date"])):
            return {"ok": False, "reason": "floor row %s is malformed" % major}
        floor[int(major)] = (v, row["date"])
    fetched = d.get("fetched_at") if isinstance(d.get("fetched_at"), str) else ""
    try:
        good = bool(re.match(r"\d{4}-\d{2}-\d{2}T", fetched, re.ASCII)) and bool(datetime.fromisoformat(fetched.replace("Z", "+00:00")))
    except ValueError:
        good = False
    if not good:
        return {"ok": False, "reason": "the floor file has no valid `fetched_at`"}
    revisit = d.get("revisit_by") if isinstance(d.get("revisit_by"), str) else ""
    if parse_date(revisit) is None or parse_date(fetched[:10]) is None:
        return {"ok": False, "reason": "the floor file has no valid `revisit_by`"}
    if revisit > add_days(fetched[:10], REVISIT_DAYS):
        return {"ok": False, "reason": "revisit_by %s is more than %d days after fetched_at %s" % (revisit, REVISIT_DAYS, fetched)}
    return {"ok": True, "floor": floor, "fetched_at": fetched, "revisit_by": revisit, "days_left": days_until(revisit, now)}


def busted(url):
    if url.startswith(("http://", "https://")):
        return url + ("&" if "?" in url else "?") + "cb=%d" % time.time_ns()
    return url


def fetch(url, timeout=20, attempts=2, cap=5_000_000):
    last = "no attempt"
    for n in range(attempts):
        try:
            req = urllib.request.Request(busted(url), headers={"User-Agent": "algovault-node-runtime-floor-canary/1"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read(cap + 1)
            if len(data) > cap:
                return None, "%s returned over %d bytes" % (url, cap)
            return data, None
        except (urllib.error.URLError, OSError, ValueError) as e:
            last = str(getattr(e, "reason", e))[:160]
        if n + 1 < attempts:
            time.sleep(3)
    return None, "cannot fetch %s (%s)" % (url, last)


# ── collect (all I/O) ────────────────────────────────────────────────────────────────────────

def collect(root, host, reg, now, docker, index_url=INDEX_URL, floor_url=FLOOR_URL):
    t0 = time.monotonic()
    mine = reg["mine"]
    obs = {"errors": [], "disk": {}, "procs": [], "images": None, "refs": [], "measured": {}, "host_paths": {},
           "live": None, "committed": None, "counts": {}}
    found, errs, counts = walk_disk(root)
    obs["disk"], obs["counts"] = found, counts
    obs["errors"] += errs

    procs, errs, npids = scan_processes(root)
    obs["errors"] += errs
    obs["counts"].update(pids=npids, node_processes=len(procs))
    for p in procs:
        if p["cid"]:
            info = docker.inspect(p["cid"])
            if "error" in info:
                obs["errors"].append("node pid %d runs in container %s, which cannot be inspected (%s)" % (p["pid"], p["cid"][:12], info["error"]))
            else:
                obs["procs"].append(dict(info, kind="container", pid=p["pid"]))
            continue
        try:
            st = os.stat(rooted(root, p["exe"]))
            same = (st.st_dev, st.st_ino) == p["ino"]
        except OSError:
            same = False
        final = resolve_in_root(root, p["exe"]) if same else None
        if final:
            obs["procs"].append({"kind": "host", "pid": p["pid"], "path": final})
        else:
            obs["errors"].append("node pid %d runs a binary that is no longer the file at %s (replaced or deleted since it started); restart it" % (p["pid"], p["exe"]))

    needs_docker = any(r["kind"] in ("container", "image") for r in mine)
    if docker.bin:
        obs["images"], err = docker.node_images()
        if err:
            obs["errors"].append(err)
    elif needs_docker:
        obs["errors"].append("docker is not on PATH, so the registry's container and image rows cannot be checked")
    obs["counts"]["node_images"] = len(obs["images"] or [])

    homes = home_dirs(root)
    jobs, errs, ncron = cron_sources(root, homes)
    units, errs2, nunits = unit_sources(root)
    obs["errors"] += errs + errs2
    for src, cmd, path, cwd, skip0 in jobs + units:
        for ref in analyze(cmd, {"root": root, "path": path, "cwd": cwd, "src": src, "argv0_skip": skip0}):
            if ref[0] != "container":
                obs["refs"].append(ref)
                continue
            info = docker.inspect(ref[1])
            if "error" in info:
                obs["errors"].append("%s runs node in container %s, which cannot be inspected (%s)" % (ref[2], ref[1], info["error"]))
            else:
                obs["refs"].append(("container", info["project"], info["service"], info["image"], ref[2]))
    obs["counts"].update(cron_files=ncron, unit_files=nunits, jobs=len(jobs) + len(units), node_refs=len(obs["refs"]))

    for r in mine:
        if r["kind"] == "host-binary":
            obs["host_paths"][r["id"]] = resolve_in_root(root, r["path"])
        if r.get("exempt") or r["measure"] == "none":
            continue
        if r["kind"] == "host-binary":
            obs["measured"][r["id"]] = measure_host(root, r["path"])
        else:
            obs["measured"][r["id"]] = docker.measure(r["match"]["compose_project"], r["match"]["compose_service"])

    if obs["measured"] or host == reg["floor_check_host"]:
        data, err = fetch(index_url)
        live = {"ok": False, "reason": err}
        if data is not None:
            try:
                idx = json.loads(data)
            except ValueError as e:
                live = {"ok": False, "reason": "the index is not JSON (%s)" % str(e)[:80]}
            else:
                live = floor_from_index(idx)
                if live["ok"]:
                    live = {"ok": True, "floor": floor_table(live["floor"]), "rows": len(idx)}
        obs["live"] = live
    if host == reg["floor_check_host"]:
        data, err = fetch(floor_url)
        com = parse_floor_file(data, now) if data is not None else {"ok": False, "reason": err}
        if data is not None:
            com["sha256"] = hashlib.sha256(data).hexdigest()
        obs["committed"] = com
    obs["counts"]["duration_s"] = round(time.monotonic() - t0, 1)
    return obs


# ── evaluate (pure) ──────────────────────────────────────────────────────────────────────────

def effective_floor(obs):
    # -> (floor {major: None | (v, date)}, fail [(key, text)], ind [text], notes [text], source)
    live, com = obs.get("live"), obs.get("committed")
    fail, ind, notes, lf, cf = [], [], [], None, None
    if live is not None:
        if live["ok"]:
            lf = live["floor"]
        else:
            ind.append("the live floor is unavailable (%s)" % live["reason"])
    if com is not None:
        if com["ok"]:
            cf = com["floor"]
            if com["days_left"] <= EXPIRY_WARNING_DAYS:
                fail.append(("floor-file-revisit:%s" % com["revisit_by"],
                             "FLOOR_FILE_EXPIRING: the committed floor file's revisit_by %s is %d days away" % (com["revisit_by"], com["days_left"])))
        else:
            ind.append("the committed floor file is unusable (%s)" % com["reason"])
    if lf is not None and cf is not None:
        for M in sorted(lf):
            lv, cv = lf[M], cf.get(M, "missing")
            if cv == "missing":
                if lv is not None:
                    fail.append(("floor-file:%s" % vstr(lv[0]), "FLOOR_FILE_BEHIND: the committed floor file has no Node %d row; the live floor is %s (%s)" % (M, vstr(lv[0]), lv[1])))
                else:
                    notes.append("the committed floor file has no Node %d row, and that line has no security release" % M)
            elif lv is not None and (cv is None or lv[0] > cv[0]):
                fail.append(("floor-file:%s" % vstr(lv[0]), "FLOOR_FILE_BEHIND: the committed Node %d floor is %s; the live floor is %s (%s)" % (M, vstr(cv[0]) if cv else "none", vstr(lv[0]), lv[1])))
            elif cv is not None and (lv is None or cv[0] > lv[0]):
                notes.append("the committed Node %d floor %s is newer than the live index's %s" % (M, vstr(cv[0]), vstr(lv[0]) if lv else "none"))
    floor = {}
    for table in (lf, cf):
        for M, x in (table or {}).items():
            if M not in floor or (x is not None and (floor[M] is None or x[0] > floor[M][0])):
                floor[M] = x
    source = "+".join(n for n, t in (("index", lf), ("committed", cf)) if t is not None) or "none"
    return floor, fail, ind, notes, source


def evaluate(reg, host, obs, now):
    fail, ind, notes = {}, list(obs["errors"]), []

    def bad(key, text):
        fail.setdefault(make_key(key), []).append(text)

    mine = reg["mine"]
    for r in mine:
        ex = r.get("exempt")
        if ex and days_until(ex["revisit_by"], now) < 0:
            bad("exemption-expired:%s" % r["id"], "EXEMPTION_EXPIRED: %s's exemption passed its revisit_by %s (%s)" % (r["id"], ex["revisit_by"], ex["reason"]))
    if obs["counts"].get("disk_dirs", 0) == 0:
        ind.append("the disk walk visited no directory, so it verified nothing")
    if obs["counts"].get("pids", 0) == 0:
        ind.append("/proc listed no process, so the process leg verified nothing")
    host_paths = {p for p in obs["host_paths"].values() if p}
    containers = {(r["match"]["compose_project"], r["match"]["compose_service"]) for r in mine if r["kind"] == "container"}
    images = {r["match"]["image"]: r["id"] for r in mine if r["kind"] == "image"}

    def unregistered(ref, what):
        bad("unregistered:%s:%s" % (host, ref), "UNREGISTERED: %s (%s) has no row in node-runtime-registry.json" % (ref, what))

    def container(project, service, image, what):
        if (project, service) not in containers and image not in images:
            unregistered("container:%s" % ("%s/%s" % (project, service) if project else image), what)

    for path, via in sorted(obs["disk"].items()):
        if path not in host_paths:
            unregistered(path, "a node binary on disk, reached as %s" % ", ".join(sorted(via)[:3]))
    for p in obs["procs"]:
        if p["kind"] == "host" and p["path"] not in host_paths:
            unregistered(p["path"], "running as pid %d" % p["pid"])
        elif p["kind"] == "container":
            container(p["project"], p["service"], p["image"], "running as pid %d" % p["pid"])
    for ref in sorted(obs["images"] or []):
        if ref not in images:
            unregistered("image:" + ref, "a node image on this host")
    if obs["images"] is not None:
        notes += ["registry row %s names image %s, which is not on this host" % (rid, ref) for ref, rid in sorted(images.items()) if ref not in obs["images"]]
    for ref in obs["refs"]:
        if ref[0] == "ind":
            ind.append(ref[1])
        elif ref[0] == "host" and ref[1] not in host_paths:
            unregistered(ref[1], "invoked by %s" % ref[2])
        elif ref[0] == "container":
            container(ref[1], ref[2], ref[3], "invoked by %s" % ref[4])
        elif ref[0] == "image" and ref[1] not in images:
            unregistered("image:" + ref[1], "run by %s" % ref[2])

    floor, ffail, find, fnotes, source = effective_floor(obs)
    for k, t in ffail:
        bad(k, t)
    ind += find
    notes += fnotes
    measured = {}
    for r in mine:
        if r.get("exempt") or r["measure"] == "none":
            continue
        vs, err = obs["measured"].get(r["id"]) or (None, "was not measured")
        if err:
            ind.append("%s: %s" % (r["id"], err))
            continue
        measured[r["id"]] = ",".join(vs)
        for v in vs:
            pv = parse_version(v)
            if pv[0] != r["line"]:
                bad("line-mismatch:%s:%d" % (r["id"], pv[0]), "LINE_MISMATCH: %s is on Node %s, but its registry line is %d" % (r["id"], v, r["line"]))
            if pv[0] not in floor:
                ind.append("%s is on Node %s, a line the floor does not know" % (r["id"], v))
                continue
            f = floor[pv[0]]
            if f is None or pv >= f[0]:
                continue
            bad("behind:%s" % vstr(f[0]), "BEHIND: %s is on Node %s, below the security floor %s (released %s)" % (r["id"], v, vstr(f[0]), f[1]))
            if now >= parse_date(f[1]) + timedelta(hours=OVERDUE_HOURS):
                bad("overdue:%s" % vstr(f[0]), "OVERDUE: %s is still below %s %d hours after its release" % (r["id"], vstr(f[0]), OVERDUE_HOURS))
    verdict = "FAIL" if fail else ("INDETERMINATE" if ind else "PASS")
    return {"verdict": verdict, "fail": fail, "ind": ind, "notes": notes, "keys": sorted(fail),
            "floor_source": source, "measured": measured}


# ── the paging plan, the bodies, state and metrics ───────────────────────────────────────────

def plan_alerts(result, state, host, now):
    # -> (actions, next state). An action is ("page", alert, keys) | ("clear", alert, reason).
    # FAIL pages NODE_RUNTIME_BEHIND with every failing key (page-on-change: only a key not yet acked
    # pages again) and ends an INDETERMINATE streak. PASS clears both. INDETERMINATE never touches
    # BEHIND, since it cannot tell whether a failing runtime was fixed; it pages on the streak's 3rd day.
    v, today = result["verdict"], now.strftime("%Y-%m-%d")
    prev = [k for k in (state.get("last_behind_keys") or []) if isinstance(k, str) and KEY_RE.fullmatch(k)]
    st = {"last_run_at": iso(now), "last_verdict": v, "last_behind_keys": prev,
          "indeterminate_since": state.get("indeterminate_since")}
    if v == "FAIL":
        cur = sorted(result["keys"])
        # a partial run (some leg unverifiable) keeps the keys it could not re-check
        extra = sorted(set(prev) - set(cur)) if result["ind"] else []
        keys = sorted((cur + extra)[:MAX_KEYS])
        st.update(last_behind_keys=keys, indeterminate_since=None)
        return [("page", "NODE_RUNTIME_BEHIND", keys),
                ("clear", "NODE_RUNTIME_FLOOR_INDETERMINATE", "a FAIL run reports its unverifiable findings itself")], st
    if v == "PASS":
        st.update(last_behind_keys=[], indeterminate_since=None)
        return [("clear", "NODE_RUNTIME_BEHIND", "every Node runtime is registered and at or above the security floor"),
                ("clear", "NODE_RUNTIME_FLOOR_INDETERMINATE", "every leg of the run verified")], st
    since = st["indeterminate_since"]
    if parse_date(since) is None or since > today:
        since = today
    st["indeterminate_since"] = since
    if now >= parse_date(since) + timedelta(days=IND_PAGE_AFTER_DAYS):
        return [("page", "NODE_RUNTIME_FLOOR_INDETERMINATE", ["since:" + since])], st
    return [("clear", "NODE_RUNTIME_FLOOR_INDETERMINATE", "the INDETERMINATE streak since %s is under 3 days" % since)], st


def _section(title, items, cap=15):
    if not items:
        return []
    out = [title + ":"] + ["  - " + t for t in items[:cap]]
    if len(items) > cap:
        out.append("  - and %d more (see the canary log)" % (len(items) - cap))
    return out


def _capped(lines):
    # Telegram takes 4096 characters; the Action line always survives the cut.
    body = "\n".join(lines)
    if len(body) <= BODY_CAP:
        return body
    tail = "\n(truncated; see the canary log)\n" + lines[-1]
    return body[: BODY_CAP - len(tail)].rstrip() + tail


def body_behind(result, host):
    fails = [t for k in sorted(result["fail"]) for t in result["fail"][k]]
    lines = ["🛑 NODE_RUNTIME_BEHIND",
             "Host: %s · %d failing findings · %d unverifiable findings" % (host, len(fails), len(result["ind"]))]
    lines += _section("Failing findings", fails) + _section("Unverifiable findings", result["ind"])
    lines += ["Floor source: %s" % result["floor_source"],
              "Fix: upgrade the runtime to its line's floor, or give a new runtime its row in "
              "ops/monitoring/node-runtime-registry.json; a newer live floor means refreshing the committed "
              "floor with node scripts/check-runtime-node-security.mjs --refresh.",
              "Action: dispatch %s via Cowork → Claude Code" % BEHIND_WAVE]
    return _capped(lines)


def body_ind(result, host, since, now):
    days = (parse_date(now.strftime("%Y-%m-%d")) - parse_date(since)).days + 1
    lines = ["🛑 NODE_RUNTIME_FLOOR_INDETERMINATE",
             "Host: %s · INDETERMINATE for %d consecutive days (since %s) · %d unverifiable findings"
             % (host, days, since, len(result["ind"]))]
    lines += _section("Unverifiable findings", result["ind"])
    lines += ["Floor source: %s" % result["floor_source"],
              "Action: dispatch %s via Cowork → Claude Code" % IND_WAVE]
    return _capped(lines)


def load_state(path):
    try:
        with open(path, encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return {}
    return st if isinstance(st, dict) else {}


def save_state(path, st):
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".node-runtime-floor.")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(st, f, sort_keys=True)
    os.replace(tmp, path)


def metrics_for(result, obs, host):
    live, com = obs.get("live") or {}, obs.get("committed") or {}
    m = {"host": host, "fail_findings": sum(len(t) for t in result["fail"].values()),
         "indeterminate_findings": len(result["ind"]), "notes": len(result["notes"]),
         "keys": result["keys"][:20], "keys_total": len(result["keys"]), "measured": result["measured"],
         "floor_source": result["floor_source"], "floor_file_sha256": (com.get("sha256") or "")[:16] or None,
         "index_rows": live.get("rows"), "legs": obs.get("counts") or {}}
    while m["keys"] and len(json.dumps(m, ensure_ascii=False)) > 6000:
        m["keys"].pop()
    return m


# ── I/O: record, page, clear; main ───────────────────────────────────────────────────────────

def record(verdict, exit_code, metrics):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import canary_result_log  # noqa: E402 — lives beside this file on the host
        ok, detail = canary_result_log.append_result(CANARY, verdict, exit_code, metrics)
    except Exception as e:  # noqa: BLE001 — a recorder failure must never change the verdict
        ok, detail = False, "import/append raised: %s" % str(e)[:160]
    print("CANARY_RESULT_LOG=%s" % detail if ok else "CANARY_RESULT_LOG_FAILED=%s" % detail, flush=True)


def page_behind(body, keys):
    proc = subprocess.run([TG, "NODE_RUNTIME_BEHIND", "CRITICAL_PERSISTENT", "-"], input=body, capture_output=True,
                          text=True, timeout=30, env=dict(os.environ, ALERT_KEYS=" ".join(keys)))
    log("wrapper NODE_RUNTIME_BEHIND exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


def page_ind(body, keys):
    proc = subprocess.run([TG, "NODE_RUNTIME_FLOOR_INDETERMINATE", "CRITICAL_PERSISTENT", "-"], input=body,
                          capture_output=True, text=True, timeout=30, env=dict(os.environ, ALERT_KEYS=" ".join(keys)))
    log("wrapper NODE_RUNTIME_FLOOR_INDETERMINATE exit=%d out=%s" % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


def clear(alert, reason):
    with open(os.devnull, "rb") as devnull:
        proc = subprocess.run([WRAPPER, "--clear", alert, reason], stdin=devnull,
                              capture_output=True, text=True, timeout=30)
    log("wrapper --clear %s exit=%d out=%s" % (alert, proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))


def _ind_result(reason):
    return {"verdict": "INDETERMINATE", "fail": {}, "ind": [reason], "notes": [], "keys": [],
            "floor_source": "none", "measured": {}}


def main(argv):
    dry = "--dry-run" in argv
    now = now_utc()
    host, err = host_label(ROOT)
    os.environ["MONITORING_HOST_LABEL"] = host or "unknown"  # canary_result_log reads it at import
    who = host or "unknown"
    reg, obs = None, {"counts": {}}
    if err is None:
        try:
            with open(REGISTRY_PATH, encoding="utf-8") as f:
                reg, err = validate_registry(json.load(f), host)
        except (OSError, ValueError) as e:
            err = "cannot read the registry %s (%s)" % (REGISTRY_PATH, str(e)[:120])
    if err is None:
        try:
            obs = collect(ROOT, host, reg, now, Docker(shutil.which("docker")))
            result = evaluate(reg, host, obs, now)
        except Exception as e:  # noqa: BLE001 — a crash must still print a verdict, never go dark
            obs, result = {"counts": {}}, _ind_result("the canary raised %s: %s" % (type(e).__name__, str(e)[:160]))
    else:
        result = _ind_result(err)
    v = result["verdict"]
    for k in sorted(result["fail"]):
        for t in result["fail"][k]:
            log("FAIL " + t)
    for t in result["ind"]:
        log("INDETERMINATE " + t)
    for t in result["notes"]:
        log("note " + t)
    c = obs.get("counts") or {}
    log("host=%s verdict=%s measured=%s floor=%s keys=%d disk_dirs=%s disk_node_binaries=%s pids=%s "
        "node_processes=%s node_images=%s jobs=%s node_refs=%s duration_s=%s"
        % (who, v, json.dumps(result["measured"], sort_keys=True), result["floor_source"], len(result["keys"]),
           c.get("disk_dirs"), c.get("disk_node_binaries"), c.get("pids"), c.get("node_processes"),
           c.get("node_images"), c.get("jobs"), c.get("node_refs"), c.get("duration_s")))
    acts, st = plan_alerts(result, load_state(STATE_PATH), who, now)
    if dry:
        for a in acts:
            log("dry-run: would %s %s%s" % (a[0], a[1], (" keys=" + " ".join(a[2])) if a[0] == "page" else ""))
    else:
        try:
            save_state(STATE_PATH, st)
        except Exception as e:  # noqa: BLE001 — fail-open: a state write failure is logged, not paged
            log("state write failed: %s" % str(e)[:160])
        for a in acts:
            try:
                if a[0] == "clear":
                    clear(a[1], a[2])
                elif a[1] == "NODE_RUNTIME_BEHIND":
                    page_behind(body_behind(result, who), a[2])
                else:
                    page_ind(body_ind(result, who, st["indeterminate_since"], now), a[2])
            except Exception as e:  # noqa: BLE001 — fail-open: the wrapper is the alert path, never the verdict
                log("wrapper invoke failed (fail-open): %s" % str(e)[:160])
        record(v, CODES[v], metrics_for(result, obs, who))
    print(f"NODE_RUNTIME_FLOOR_VERDICT={v}", flush=True)
    return CODES[v]


# ── self-test ────────────────────────────────────────────────────────────────────────────────

def self_test():
    try:
        return _self_test()
    except Exception as e:  # noqa: BLE001 — a self-test that raises is a failing self-test
        print("SELF-TEST: FAIL (the self-test raised %s: %s)" % (type(e).__name__, str(e)[:160]))
        return 1


def _self_test():
    fails, ran = [], [0]

    def check(name, cond):
        ran[0] += 1
        try:
            ok = bool(cond() if callable(cond) else cond)
        except Exception as e:  # noqa: BLE001 — a raising check is a failing check
            ok, name = False, "%s (raised %s: %s)" % (name, type(e).__name__, str(e)[:100])
        print(("  ok    " if ok else "  FAIL  ") + name)
        if not ok:
            fails.append(name)

    NOW = datetime(2026, 10, 24, 10, 31, tzinfo=timezone.utc)
    REG_DOC = {"floor_check_host": "signal-1", "runtimes": [
        {"id": "s1-app", "host": "signal-1", "kind": "container", "measure": "docker-exec", "line": 24,
         "match": {"compose_project": "p", "compose_service": "app"}},
        {"id": "s1-host", "host": "signal-1", "kind": "host-binary", "measure": "exec-version", "line": 24,
         "path": "/usr/bin/node"},
        {"id": "s1-img", "host": "signal-1", "kind": "image", "measure": "none", "line": 24,
         "match": {"image": "node:24-alpine"}, "exempt": {"reason": "build residue", "revisit_by": "2027-01-31"}},
        {"id": "a1-img", "host": "aoe-1", "kind": "image", "measure": "none", "line": 20,
         "match": {"image": "node:20-bookworm-slim"}, "exempt": {"reason": "the Q7 harness", "revisit_by": "2027-01-31"}},
        {"id": "ci-x", "host": "ci", "kind": "ci-floating", "measure": "none", "line": 24,
         "workflow": ".github/workflows/x.yml", "node_version": "24"},
        {"id": "mac", "host": "mac", "kind": "dev", "measure": "none", "line": 24},
    ]}
    REG, e = validate_registry(REG_DOC, "signal-1")
    A1, e1 = validate_registry(REG_DOC, "aoe-1")
    check("the fixture registry validates for both hosts", REG is not None and A1 is not None and e is None and e1 is None)
    LIVE = {24: ((24, 22, 1), "2026-10-20"), 22: ((22, 23, 4), "2026-10-20"), 23: None}
    COM_OK = {"ok": True, "floor": dict(LIVE), "revisit_by": "2026-12-08", "days_left": days_until("2026-12-08", NOW),
              "sha256": "ab" * 32}

    def obs(**kw):
        o = {"errors": [], "disk": {"/usr/bin/node": ["/bin/node", "/usr/bin/node"]},
             "procs": [{"kind": "container", "pid": 7, "project": "p", "service": "app", "image": "img:x"},
                       {"kind": "host", "pid": 8, "path": "/usr/bin/node"}],
             "images": ["node:24-alpine"], "refs": [("host", "/usr/bin/node", "/etc/crontab:3"),
                                                     ("container", "p", "app", "img:x", "/etc/cron.d/j:2")],
             "measured": {"s1-app": (["v24.22.1"], None), "s1-host": (["v24.22.1"], None)},
             "host_paths": {"s1-host": "/usr/bin/node"}, "live": {"ok": True, "floor": dict(LIVE), "rows": 800},
             "committed": dict(COM_OK), "counts": {"disk_dirs": 10, "pids": 5}}
        o.update(kw)
        return o

    def ev(o=None, now=NOW, reg=None, host="signal-1"):
        return evaluate(reg or REG, host, obs() if o is None else o, now)

    def host_v(v):
        return {"s1-app": (["v24.22.1"], None), "s1-host": ([v], None)}

    def com(**kw):
        return dict(COM_OK, **kw)

    r = ev()
    check("a clean signal-1 run is PASS with no keys", r["verdict"] == "PASS" and r["keys"] == [] and not r["ind"])
    check("the floor source is index+committed", r["floor_source"] == "index+committed")
    check("measured versions reach the result", r["measured"] == {"s1-app": "v24.22.1", "s1-host": "v24.22.1"})
    # BEHIND and OVERDUE (72 h after the floor release's index date, 2026-10-20 -> 2026-10-23T00:00Z)
    r = ev(obs(measured=host_v("v24.9.0")))
    check("below the floor is FAIL behind:<floor>", r["verdict"] == "FAIL" and "behind:24.22.1" in r["keys"])
    check("behind text names the row and both versions",
          any("s1-host" in t and "v24.9.0" in t and "24.22.1" in t for t in r["fail"]["behind:24.22.1"]))
    early = ev(obs(measured=host_v("v24.9.0")), now=datetime(2026, 10, 22, 23, 59, 59, tzinfo=timezone.utc))
    late = ev(obs(measured=host_v("v24.9.0")), now=datetime(2026, 10, 23, 0, 0, tzinfo=timezone.utc))
    check("no overdue key 1 s before 72 h", "overdue:24.22.1" not in early["keys"] and "behind:24.22.1" in early["keys"])
    check("overdue key at exactly 72 h", "overdue:24.22.1" in late["keys"])
    check("a version at the floor is not behind", ev(obs(measured=host_v("v24.22.1")))["verdict"] == "PASS")
    check("a version above the floor is not behind", ev(obs(measured=host_v("v24.30.0")))["verdict"] == "PASS")
    check("a multi-replica row is judged per replica",
          "behind:24.22.1" in ev(obs(measured={"s1-app": (["v24.22.1", "v24.1.0"], None), "s1-host": (["v24.22.1"], None)}))["keys"])
    # LINE_MISMATCH
    r = ev(obs(measured=host_v("v22.23.4")))
    check("another major at its floor is LINE_MISMATCH only", r["verdict"] == "FAIL" and r["keys"] == ["line-mismatch:s1-host:22"])
    r = ev(obs(measured=host_v("v22.1.0")))
    check("another major below its floor is LINE_MISMATCH + BEHIND",
          {"line-mismatch:s1-host:22", "behind:22.23.4"} <= set(r["keys"]))
    # UNREGISTERED, per leg
    r = ev(obs(disk={"/usr/bin/node": ["/usr/bin/node"], "/opt/stray/node": ["/opt/stray/node"]}))
    check("an unregistered disk binary is FAIL", r["verdict"] == "FAIL" and r["keys"] == ["unregistered:signal-1:/opt/stray/node"])
    r = ev(obs(procs=[{"kind": "host", "pid": 9, "path": "/usr/local/bin/node"}]))
    check("an unregistered host process is FAIL", r["keys"] == ["unregistered:signal-1:/usr/local/bin/node"])
    r = ev(obs(procs=[{"kind": "container", "pid": 9, "project": "q", "service": "other", "image": "img:y"}]))
    check("an unregistered compose container is FAIL", r["keys"] == ["unregistered:signal-1:container:q/other"])
    r = ev(obs(procs=[{"kind": "container", "pid": 9, "project": "", "service": "", "image": "x:1"}]))
    check("an unlabelled container is keyed by its image", r["keys"] == ["unregistered:signal-1:container:x:1"])
    r = ev(obs(procs=[{"kind": "container", "pid": 9, "project": "", "service": "", "image": "node:24-alpine"}]))
    check("a container of a registered image is registered", r["verdict"] == "PASS")
    r = ev(obs(images=["node:24-alpine", "node:25"]))
    check("an unregistered node image is FAIL", r["keys"] == ["unregistered:signal-1:image:node:25"])
    r = ev(obs(refs=[("host", "/usr/local/bin/node", "/etc/crontab:4")]))
    check("an unregistered cron/unit host ref is FAIL", r["keys"] == ["unregistered:signal-1:/usr/local/bin/node"])
    r = ev(obs(refs=[("image", "node:18", "/etc/cron.d/x:2")]))
    check("an unregistered docker-run image ref is FAIL", r["keys"] == ["unregistered:signal-1:image:node:18"])
    r = ev(obs(refs=[("container", "q", "w", "img:z", "/etc/crontab:9")]))
    check("an unregistered docker-exec container ref is FAIL", r["keys"] == ["unregistered:signal-1:container:q/w"])
    r = ev(obs(refs=[("ind", "/etc/crontab:5 cannot be parsed")]))
    check("an unparseable node invocation is INDETERMINATE", r["verdict"] == "INDETERMINATE" and r["keys"] == [])
    r = ev(obs(images=[]))
    check("a registered image absent from the host is a note, not a finding",
          r["verdict"] == "PASS" and any("node:24-alpine" in t for t in r["notes"]))
    r = ev(obs(host_paths={"s1-host": "/usr/bin/node"}, disk={"/usr/bin/node": ["/bin/node"]}))
    check("a registered binary reached through an alias path is registered", r["verdict"] == "PASS")
    # EXEMPTION_EXPIRED (the gate's floored days_until: expired once revisit_by 00:00Z has passed)
    check("an exemption inside revisit_by is not a finding",
          ev(now=datetime(2027, 1, 30, 12, 0, tzinfo=timezone.utc))["verdict"] == "PASS")
    r = ev(now=datetime(2027, 2, 1, tzinfo=timezone.utc))
    check("a passed revisit_by is EXEMPTION_EXPIRED", r["verdict"] == "FAIL" and r["keys"] == ["exemption-expired:s1-img"])
    # the committed floor file
    r = ev(obs(committed=com(floor={24: ((24, 9, 0), "2026-07-01"), 22: LIVE[22], 23: None})))
    check("a live floor newer than the committed one is FLOOR_FILE_BEHIND", r["keys"] == ["floor-file:24.22.1"])
    r = ev(obs(committed=com(floor={24: LIVE[24], 23: None})))
    check("a committed file missing a secured major is FLOOR_FILE_BEHIND", r["keys"] == ["floor-file:22.23.4"])
    r = ev(obs(committed=com(floor={24: LIVE[24], 22: LIVE[22]})))
    check("a committed file missing a never-secured major is a note",
          r["verdict"] == "PASS" and any("Node 23" in t for t in r["notes"]))
    r = ev(obs(committed=com(floor={24: ((24, 23, 0), "2026-10-23"), 22: LIVE[22], 23: None})))
    check("a committed floor newer than the index is a note", any("newer than the live index" in t for t in r["notes"]))
    check("the effective floor is the newer of the two", r["keys"] == ["behind:24.23.0"])
    check("revisit_by 7 days away is FLOOR_FILE_EXPIRING",
          ev(obs(committed=com(days_left=7)))["keys"] == ["floor-file-revisit:2026-12-08"])
    check("revisit_by 8 days away is not", ev(obs(committed=com(days_left=8)))["verdict"] == "PASS")
    check("an unusable committed file is INDETERMINATE",
          ev(obs(committed={"ok": False, "reason": "x"}))["verdict"] == "INDETERMINATE")
    # INDETERMINATE causes, and precedence
    r = ev(obs(live={"ok": False, "reason": "cannot fetch"}))
    check("an index failure is INDETERMINATE", r["verdict"] == "INDETERMINATE" and r["floor_source"] == "committed")
    r = ev(obs(live={"ok": False, "reason": "cannot fetch"}, measured=host_v("v24.9.0")))
    check("an index failure still FAILs a runtime behind the committed floor",
          r["verdict"] == "FAIL" and "behind:24.22.1" in r["keys"] and r["ind"])
    no24 = {22: LIVE[22], 23: None}
    r = ev(obs(live={"ok": True, "floor": dict(no24), "rows": 800}, committed=com(floor=dict(no24))))
    check("a major the floor does not know is INDETERMINATE", r["verdict"] == "INDETERMINATE")
    nulls = {24: None, 22: None, 23: None}
    r = ev(obs(live={"ok": True, "floor": dict(nulls), "rows": 800}, committed=com(floor=dict(nulls))))
    check("a line with no security release passes", r["verdict"] == "PASS")
    r = ev(obs(measured={"s1-app": (None, "no running replica of p/app"), "s1-host": (["v24.22.1"], None)}))
    check("a measurement error is INDETERMINATE", r["verdict"] == "INDETERMINATE" and any("s1-app" in t for t in r["ind"]))
    r = ev(obs(measured={"s1-host": (["v24.22.1"], None)}))
    check("a row that was never measured is INDETERMINATE", r["verdict"] == "INDETERMINATE")
    check("a leg error is INDETERMINATE", ev(obs(errors=["cannot read /proc/1/exe (Permission denied)"]))["verdict"] == "INDETERMINATE")
    check("a disk walk that visited nothing is INDETERMINATE",
          ev(obs(counts={"disk_dirs": 0, "pids": 5}))["verdict"] == "INDETERMINATE")
    check("a /proc that listed nothing is INDETERMINATE",
          ev(obs(counts={"disk_dirs": 10, "pids": 0}))["verdict"] == "INDETERMINATE")
    r = ev(obs(errors=["x"], measured=host_v("v24.9.0")))
    check("FAIL outranks INDETERMINATE", r["verdict"] == "FAIL" and r["ind"] == ["x"])
    # aoe-1: enumeration only
    a1 = obs(disk={}, procs=[], images=["node:20-bookworm-slim"], refs=[], measured={}, host_paths={}, live=None, committed=None)
    r = ev(a1, reg=A1, host="aoe-1")
    check("aoe-1 with only its exempt harness image is PASS without any floor", r["verdict"] == "PASS" and r["floor_source"] == "none")
    r = ev(dict(a1, images=["node:20-bookworm-slim", "node:22"]), reg=A1, host="aoe-1")
    check("aoe-1 with an unregistered image is FAIL", r["keys"] == ["unregistered:aoe-1:image:node:22"])
    r = ev(dict(a1, disk={"/usr/local/bin/node": ["/usr/local/bin/node"]}), reg=A1, host="aoe-1")
    check("aoe-1 with a host node binary is FAIL", r["keys"] == ["unregistered:aoe-1:/usr/local/bin/node"])

    _self_test_parsers(check, NOW, REG_DOC)
    if ran[0] == 0:
        print("SELF-TEST: FAIL (vacuous — no checks ran)")
        return 1
    if fails:
        print("SELF-TEST: FAIL (%d of %d)" % (len(fails), ran[0]))
        return 1
    print("SELF-TEST: PASS (%d checks)" % ran[0])
    return 0


SEC = ({"version": "v24.22.1", "date": "2026-10-20", "security": True},
       {"version": "v24.9.0", "date": "2026-05-01", "security": True},
       {"version": "v22.23.4", "date": "2026-10-20", "security": True},
       {"version": "v16.20.2", "date": "2023-08-09", "security": True})


def _index(extra=(), majors=(18, 20, 22, 24), per=30):
    rows = [{"version": "v%d.0.%d" % (M, n), "date": "2026-01-01", "security": False} for M in majors for n in range(per)]
    return rows + [dict(r) for r in extra]


def _self_test_parsers(check, NOW, REG_DOC):
    def bad_reg(mut, host="signal-1"):
        d = json.loads(json.dumps(REG_DOC))
        mut(d)
        return validate_registry(d, host)[0] is None

    check("a container row measured as none is refused", lambda: bad_reg(lambda d: d["runtimes"][0].update(measure="none")))
    check("a duplicate id is refused", lambda: bad_reg(lambda d: d["runtimes"].append(dict(d["runtimes"][1]))))
    check("an unknown floor_check_host is refused", lambda: bad_reg(lambda d: d.update(floor_check_host="ci")))
    check("a malformed exempt is refused", lambda: bad_reg(lambda d: d["runtimes"][2]["exempt"].update(revisit_by="2027-13-01")))
    check("a relative host-binary path is refused", lambda: bad_reg(lambda d: d["runtimes"][1].update(path="usr/bin/node")))
    check("an unknown kind is refused", lambda: bad_reg(lambda d: d["runtimes"][5].update(kind="laptop")))
    check("a non-integer line is refused", lambda: bad_reg(lambda d: d["runtimes"][0].update(line="24")))
    check("an invalid id is refused", lambda: bad_reg(lambda d: d["runtimes"][0].update(id="S1 App")))
    check("a ci row without node_version is refused", lambda: bad_reg(lambda d: d["runtimes"][4].pop("node_version")))
    check("zero rows for the host is refused",
          lambda: bad_reg(lambda d: d.update(runtimes=[r for r in d["runtimes"] if r["host"] != "signal-1"])))
    check("an empty registry is refused", lambda: bad_reg(lambda d: d.update(runtimes=[])))

    check("parse_version reads v24.22.1", parse_version("v24.22.1") == (24, 22, 1))
    check("parse_version refuses a suffix, a short form and non-ASCII digits",
          parse_version("v24.22.1-rc.1") is None and parse_version("24.22") is None and parse_version("v２４.22.1") is None)
    check("make_key replaces characters outside KEY_RE",
          make_key("unregistered:signal-1:/opt/x y/node") == "unregistered:signal-1:/opt/x_y/node")
    longk = make_key("unregistered:signal-1:/" + "a" * 300)
    check("make_key caps a long key at 128 with a hash suffix", len(longk) == 128 and bool(KEY_RE.fullmatch(longk)))
    check("days_until floors like the gate",
          days_until("2026-10-25", NOW) == 0 and days_until("2026-10-24", NOW) == -1 and days_until("2026-12-08", NOW) == 44)

    f = floor_from_index(_index(SEC))
    check("the floor is the newest security release per major, compared numerically",
          lambda: f["ok"] and f["floor"]["24"] == {"version": "24.22.1", "date": "2026-10-20"}
          and f["floor"]["22"] == {"version": "22.23.4", "date": "2026-10-20"})
    check("a major with no security release floors at null",
          lambda: f["floor"]["18"] == {"version": None, "date": None} and f["floor"]["20"] == {"version": None, "date": None})
    check("lines below 18 are not floored", lambda: "16" not in f["floor"])
    check("a non-array index is refused", not floor_from_index({"a": 1})["ok"])
    check("an index under 100 releases is refused", lambda: "release rows" in floor_from_index(_index(SEC)[:99])["reason"])
    check("a row without a boolean security field is refused",
          lambda: "boolean" in floor_from_index(_index(SEC) + [{"version": "v24.1.0", "date": "2026-01-01"}])["reason"])
    check("a security row without a date is refused",
          lambda: "date" in floor_from_index(_index(SEC) + [{"version": "v24.1.1", "security": True}])["reason"])
    check("an index with no security release is refused", lambda: "security" in floor_from_index(_index())["reason"])
    check("an index whose newest line is below 24 is refused",
          lambda: "at or above" in floor_from_index(_index([SEC[2]], majors=(18, 20, 22, 23)))["reason"])

    good = {"fetched_at": "2026-10-24T17:25:04Z", "revisit_by": "2026-12-08",
            "floor": {"18": {"version": None, "date": None}, "24": {"version": "24.22.1", "date": "2026-10-20"}}}

    def pf(**kw):
        return parse_floor_file(json.dumps(dict(good, **kw)), NOW)

    p = pf()
    check("a good floor file parses", lambda: p["ok"] and p["floor"] == {18: None, 24: ((24, 22, 1), "2026-10-20")}
          and p["days_left"] == 44 and p["revisit_by"] == "2026-12-08")
    check("revisit_by at fetched_at + 45 days is accepted", pf(revisit_by="2026-12-08")["ok"])
    check("revisit_by beyond fetched_at + 45 days is refused", not pf(revisit_by="2026-12-09")["ok"])
    check("a row whose major disagrees with its key is refused", not pf(floor={"23": {"version": "24.22.1", "date": "2026-10-20"}})["ok"])
    check("a half-null row is refused", not pf(floor={"23": {"version": None}})["ok"])
    check("a row without a date is refused", not pf(floor={"24": {"version": "24.22.1"}})["ok"])
    check("a fetched_at that is not an ISO timestamp is refused",
          lambda: all("fetched_at" in pf(fetched_at=x)["reason"] for x in ("yesterday", "2026-10-24", "2026-10-24Tnonsense")))
    check("an empty floor is refused", not pf(floor={})["ok"])
    check("a non-JSON floor file is refused", not parse_floor_file(b"<html>", NOW)["ok"])
    data, why = fetch("file:///nonexistent-nrf-selftest/index.json", attempts=1)
    check("a fetch failure returns no data and a reason", data is None and "cannot fetch" in (why or ""))
    check("http(s) URLs are cache-busted, file URLs are not",
          re.fullmatch(r"https://x/y\?cb=\d+", busted("https://x/y")) and busted("https://x/y?a=1").startswith("https://x/y?a=1&cb=")
          and busted("file:///a") == "file:///a")

    def res(v, keys=(), ind=()):
        return {"verdict": v, "fail": {k: ["BEHIND: x"] for k in keys}, "ind": list(ind), "notes": [],
                "keys": sorted(keys), "floor_source": "index+committed", "measured": {}}

    acts, st = plan_alerts(res("FAIL", ["behind:24.23.0"]), {"indeterminate_since": "2026-10-22"}, "signal-1", NOW)
    check("FAIL pages BEHIND with its keys and ends an INDETERMINATE streak",
          len(acts) == 2 and acts[0] == ("page", "NODE_RUNTIME_BEHIND", ["behind:24.23.0"])
          and acts[1][:2] == ("clear", "NODE_RUNTIME_FLOOR_INDETERMINATE")
          and st["last_behind_keys"] == ["behind:24.23.0"] and st["indeterminate_since"] is None)
    acts, _ = plan_alerts(res("FAIL", ["unregistered:signal-1:/x"], ind=["y"]), {"last_behind_keys": ["behind:24.23.0"]}, "signal-1", NOW)
    check("a partial FAIL keeps the keys it could not re-check", acts[0][2] == ["behind:24.23.0", "unregistered:signal-1:/x"])
    acts, _ = plan_alerts(res("FAIL", ["unregistered:signal-1:/x"]), {"last_behind_keys": ["behind:24.23.0"]}, "signal-1", NOW)
    check("a full FAIL drops the keys that are gone", acts[0][2] == ["unregistered:signal-1:/x"])
    acts, _ = plan_alerts(res("FAIL", ["k%03d" % i for i in range(150)]), {}, "signal-1", NOW)
    check("the page's key set is capped at MAX_KEYS", len(acts[0][2]) == MAX_KEYS)
    acts, st = plan_alerts(res("PASS"), {"last_behind_keys": ["behind:24.23.0"], "indeterminate_since": "2026-10-20"}, "signal-1", NOW)
    check("PASS clears both alerts and resets the state",
          [a[:2] for a in acts] == [("clear", "NODE_RUNTIME_BEHIND"), ("clear", "NODE_RUNTIME_FLOOR_INDETERMINATE")]
          and st["last_behind_keys"] == [] and st["indeterminate_since"] is None)
    acts, st = plan_alerts(res("INDETERMINATE", ind=["x"]), {}, "signal-1", NOW)
    check("INDETERMINATE day 1 starts the streak without a page",
          st["indeterminate_since"] == "2026-10-24" and [a[0] for a in acts] == ["clear"])
    acts, _ = plan_alerts(res("INDETERMINATE", ind=["x"]), {"indeterminate_since": "2026-10-23"}, "signal-1", NOW)
    check("INDETERMINATE day 2 does not page", [a[0] for a in acts] == ["clear"])
    acts, st = plan_alerts(res("INDETERMINATE", ind=["x"]), {"indeterminate_since": "2026-10-22", "last_behind_keys": ["behind:24.23.0"]},
                           "signal-1", NOW)
    check("INDETERMINATE day 3 pages, keyed by the streak's start",
          acts == [("page", "NODE_RUNTIME_FLOOR_INDETERMINATE", ["since:2026-10-22"])])
    check("INDETERMINATE never touches BEHIND or its keys", st["last_behind_keys"] == ["behind:24.23.0"])
    _, st = plan_alerts(res("INDETERMINATE", ind=["x"]), {"indeterminate_since": "2027-01-01"}, "signal-1", NOW)
    check("a streak start in the future resets to today", st["indeterminate_since"] == "2026-10-24")

    b = body_behind(res("FAIL", ["behind:24.23.0"]), "signal-1")
    check("the BEHIND body starts with its alert and ends with the template Action line",
          b.startswith("🛑 NODE_RUNTIME_BEHIND\n") and not re.search(r"-W\d", b)
          and b.endswith("\nAction: dispatch OPS-NODE-SECURITY-FLOOR-W{NEXT} via Cowork → Claude Code"))
    huge = {"verdict": "FAIL", "fail": {"k%03d" % i: ["UNREGISTERED: " + "x" * 200] for i in range(500)},
            "ind": ["y" * 300] * 50, "notes": [], "keys": [], "floor_source": "index", "measured": {}}
    hb = body_behind(huge, "signal-1")
    check("a huge BEHIND body is capped and keeps its Action line",
          len(hb) <= BODY_CAP and hb.endswith("\nAction: dispatch OPS-NODE-SECURITY-FLOOR-W{NEXT} via Cowork → Claude Code"))
    ib = body_ind(res("INDETERMINATE", ind=["cannot fetch"]), "signal-1", "2026-10-22", NOW)
    check("the INDETERMINATE body counts the streak and ends with its Action line",
          ib.startswith("🛑 NODE_RUNTIME_FLOOR_INDETERMINATE\n") and "3 consecutive days (since 2026-10-22)" in ib
          and not re.search(r"-W\d", ib)
          and ib.endswith("\nAction: dispatch OPS-NODE-RUNTIME-FLOOR-CANARY-W{NEXT} via Cowork → Claude Code"))
    m = metrics_for(dict(huge, keys=["k%04d" % i for i in range(1000)]), {"counts": {"disk_dirs": 1}}, "signal-1")
    check("metrics stay under 6000 bytes with 1000 keys", len(json.dumps(m, ensure_ascii=False)) <= 6000 and m["keys_total"] == 1000)

    root = os.path.realpath(tempfile.mkdtemp(prefix="nrf-selftest-"))
    try:
        _self_test_fs(check, root, NOW)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _self_test_fs(check, root, NOW):
    def put(rel, text, mode=0o644):
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(p, mode)
        return p

    put("usr/bin/node", "#!/bin/sh\necho v24.22.1\n", 0o755)
    os.symlink("usr/bin", os.path.join(root, "bin"))
    os.makedirs(os.path.join(root, "opt"))
    os.symlink("/usr/bin/node", os.path.join(root, "opt/a"))
    os.symlink("loop2", os.path.join(root, "opt/loop1"))
    os.symlink("loop1", os.path.join(root, "opt/loop2"))
    put("opt/app/run.sh", "#!/usr/bin/env node\nconsole.log(1)\n", 0o755)
    put("opt/app/bad.sh", "#!/usr/local/bin/node\n", 0o755)
    put("opt/app/plain.sh", "#!/bin/sh\necho hi\n", 0o755)

    check("a relative directory link resolves inside the root", resolve_in_root(root, "/bin/node") == "/usr/bin/node")
    check("an absolute link is re-rooted", resolve_in_root(root, "/opt/a") == "/usr/bin/node")
    check("a link loop resolves to None", resolve_in_root(root, "/opt/loop1") is None)

    ctx = {"root": root, "path": "/usr/bin:/bin", "cwd": "/root", "src": "t:1", "argv0_skip": False}
    H = [("host", "/usr/bin/node", "t:1")]

    def A(cmd, **kw):
        return analyze(cmd, dict(ctx, **kw))

    def is_ind(refs):
        return len(refs) == 1 and refs[0][0] == "ind"

    for name, cmd, want in (
        ("flock + docker exec -u", "flock -n /var/lock/x.lock docker exec -u root mcp node -e 1", [("container", "mcp", "t:1")]),
        ("cd && node with redirects", "cd /opt/app && /usr/bin/node server.js >> /var/log/x.log 2>&1", H),
        ("cd then a relative script", "cd /opt/app && ./run.sh", H),
        ("/usr/bin/env node", "/usr/bin/env node /opt/x.js", H),
        ("timeout + nice", "timeout 600 nice -n 10 node x.js", H),
        ("sh -c", "sh -c 'cd /srv && node app.js'", H),
        ("bash -lc + flock -c", "bash -lc \"flock /tmp/l -c 'node x.js'\"", H),
        ("a leading redirect", "2>/dev/null node x.js", H),
        ("a for loop body", "for f in a b; do node $f; done", H),
        ("backticks", "echo `node -v`", H),
        ("command -v", "command -v node", []),
        ("sudo -u", "sudo -u app node x.js", H),
        ("env -S", "env -S 'node --max-old-space-size=512' x.js", H),
        ("docker run of a node image", "docker run --rm -v /a:/b node:24-alpine npm ci", [("image", "node:24-alpine", "t:1")]),
        ("docker run of another image running node", "docker run --rm img/app:1 node x.js", [("image", "img/app:1", "t:1")]),
        ("docker run of another image", "docker run --rm img/app:1 python x.py", []),
        ("a script whose #! is env node", "/opt/app/run.sh", H),
        ("a plain script", "/opt/app/plain.sh", []),
        ("bash running a script file", "bash /opt/app/x.sh", []),
    ):
        check("analyze: %s" % name, lambda c=cmd, w=want: A(c) == w)
    check("docker run with an unknown option and node is INDETERMINATE", is_ind(A("docker run --frobnicate img node x.js")))
    check("docker run with an unknown option and no node is ignored", A("docker run --frobnicate img python x.py") == [])
    check("docker compose exec node is INDETERMINATE", is_ind(A("docker compose exec mcp-server node -v")))
    check("an unbalanced quote around node is INDETERMINATE", is_ind(A("node 'x")))
    check("an unbalanced quote without node is ignored", A("echo 'x") == [])
    check("node missing from PATH is INDETERMINATE", is_ind(A("node x.js", path="/nonexistent")))
    check("a #! naming an absent node is INDETERMINATE", is_ind(A("/opt/app/bad.sh")))
    check("PATH=/nonexistent node is INDETERMINATE", is_ind(A("PATH=/nonexistent node x.js")))
    check("a bare PATH= persists for the rest of the line", A("PATH=/usr/bin; node x.js", path="/nonexistent") == H)
    check("PATH=dir:$PATH extends the PATH", A("PATH=/usr/bin:$PATH node x.js", path="/nonexistent") == H)
    check("systemd @ drops argv[0]", A("/bin/sh sh -c 'node x'", argv0_skip=True) == H)
    check("without @ the same line runs no node", A("/bin/sh sh -c 'node x'") == [])
    check("node-runtime-* and node_modules are not node words",
          not NODEISH_RE.search("python3 /opt/algovault-monitoring/node-runtime-floor-canary.py")
          and not NODEISH_RE.search("ls /srv/node_modules/x") and bool(NODEISH_RE.search("cd /x && nodejs y")))

    homes = {"root": "/root", "app": "/home/app"}
    text = ("PATH=/usr/local/bin:/usr/bin\n# a comment\n"
            "*/5 * * * * root node /x.js > /dev/null 2>&1 % stdin text\n"
            "@reboot root /usr/bin/node y.js\n"
            "17 3 * * * app printf '\\%s' a\n")
    jobs = cron_jobs(text, True, "/etc/cron.d/j", homes)
    check("cron_jobs reads the user field, cuts at %, keeps PATH",
          lambda: jobs[0] == ("/etc/cron.d/j:3", "node /x.js > /dev/null 2>&1 ", "/usr/local/bin:/usr/bin", "/root", False))
    check("cron_jobs reads an @nickname line", lambda: jobs[1][1] == "/usr/bin/node y.js")
    check("cron_jobs turns \\% into % and runs in the user's home", lambda: jobs[2][1] == "printf '%s' a" and jobs[2][3] == "/home/app")
    spool = cron_jobs("0 * * * * node z.js\n", False, "/var/spool/cron/crontabs/app", homes, owner="app")
    check("a spool crontab has no user field and runs in its owner's home",
          spool == [("/var/spool/cron/crontabs/app:1", "node z.js", CRON_PATH, "/home/app", False)])
    unit = ("[Service]\nWorkingDirectory=/srv/app\nExecStart=\nExecStart=-/usr/bin/node \\\n  server.js\n"
            "ExecStartPre=@/bin/sh sh -c 'true'\n")
    uj = unit_exec_lines(unit, "/etc/systemd/system/x.service")
    check("an empty ExecStart= is no job", len(uj) == 2)
    check("a continuation joins, its prefix is stripped, WorkingDirectory applies",
          lambda: uj[0][0] == "/etc/systemd/system/x.service:4" and uj[0][1].split() == ["/usr/bin/node", "server.js"]
          and uj[0][3] == "/srv/app" and uj[0][4] is False)
    check("@ marks argv[0]", lambda: uj[1][1] == "/bin/sh sh -c 'true'" and uj[1][4] is True)

    # end to end through collect(): a fake root with every leg populated
    put("mnt/nfs/node", "#!/bin/sh\necho v20.0.0\n", 0o755)
    put("proc/self/mounts", "/dev/sda1 / ext4 rw 0 0\nnfs:/x /mnt/nfs nfs rw 0 0\n")
    put("proc/100/cgroup", "0::/system.slice/cron.service\n")
    os.symlink(os.path.join(root, "usr/bin/node"), os.path.join(root, "proc/100/exe"))
    put("etc/passwd", "root:x:0:0:root:/root:/bin/bash\n")
    put("etc/crontab", "* * * * * root /usr/bin/env node /x.js\n")
    put("etc/systemd/system/app.service", "[Service]\nExecStart=/usr/bin/node /srv/app.js\n")
    put("srv/index.json", json.dumps(_index(SEC)))
    put("srv/bad.json", "<html>")
    put("srv/floor.json", json.dumps({"fetched_at": "2026-10-24T17:25:04Z", "revisit_by": "2026-12-08", "floor": {
        "18": {"version": None, "date": None}, "20": {"version": None, "date": None},
        "22": {"version": "22.23.4", "date": "2026-10-20"}, "24": {"version": "24.22.1", "date": "2026-10-20"}}}))
    for p in ("opt/app/run.sh", "opt/app/bad.sh", "opt/app/plain.sh"):
        os.unlink(os.path.join(root, p))
    reg, _ = validate_registry({"floor_check_host": "signal-1", "runtimes": [
        {"id": "w-node", "host": "signal-1", "kind": "host-binary", "measure": "exec-version", "line": 24,
         "path": "/usr/bin/node"}]}, "signal-1")

    def world(index="srv/index.json"):
        o = collect(root, "signal-1", reg, NOW, Docker(None), index_url="file://" + os.path.join(root, index),
                    floor_url="file://" + os.path.join(root, "srv/floor.json"))
        return o, evaluate(reg, "signal-1", o, NOW)

    o, r = world()
    check("the fake root is PASS end to end", r["verdict"] == "PASS" and r["measured"] == {"w-node": "v24.22.1"})
    check("the walk pruned the foreign mount and found the binary once", o["disk"] == {"/usr/bin/node": ["/usr/bin/node"]})
    check("the process leg attributed pid 100 to the binary", o["procs"] == [{"kind": "host", "pid": 100, "path": "/usr/bin/node"}])
    check("cron and the unit both resolved to the binary",
          sorted(x[2] for x in o["refs"]) == ["/etc/crontab:1", "/etc/systemd/system/app.service:2"]
          and all(x[:2] == ("host", "/usr/bin/node") for x in o["refs"]))
    check("both floors were read", lambda: o["live"]["ok"] and o["live"]["rows"] == 124 and o["committed"]["ok"]
          and len(o["committed"]["sha256"]) == 64)
    put("opt/stray/node", "#!/bin/sh\necho v18.0.0\n", 0o755)
    _, r = world()
    check("a stray binary in the fake root is FAIL UNREGISTERED",
          r["verdict"] == "FAIL" and r["keys"] == ["unregistered:signal-1:/opt/stray/node"])
    os.unlink(os.path.join(root, "opt/stray/node"))
    _, r = world(index="srv/bad.json")
    check("an unreadable index in the fake root is INDETERMINATE",
          r["verdict"] == "INDETERMINATE" and r["floor_source"] == "committed")
    real_scan = scan_processes
    try:
        globals()["scan_processes"] = lambda _root: ([
            {"pid": 101, "exe": "/usr/bin/node", "cid": None, "ino": (0, 0)},
            {"pid": 102, "exe": "/usr/local/bin/node", "cid": "c" * 64, "ino": (0, 0)}], [], 2)
        _, r = world()
    finally:
        globals()["scan_processes"] = real_scan
    check("a node process whose binary changed since it started is INDETERMINATE",
          r["verdict"] == "INDETERMINATE" and any("pid 101" in t and "restart it" in t for t in r["ind"]))
    check("a container node process that cannot be inspected is INDETERMINATE", any("pid 102" in t for t in r["ind"]))

    saved = os.environ.get("MONITORING_HOST_LABEL")
    try:
        os.environ["MONITORING_HOST_LABEL"] = "aoe-1"
        check("the env host label wins", host_label("/nonexistent-root") == ("aoe-1", None))
        os.environ["MONITORING_HOST_LABEL"] = "laptop"
        check("an unknown host label is refused", host_label("/nonexistent-root")[0] is None)
        os.environ["MONITORING_HOST_LABEL"] = ""
        put("etc/algovault-host-label", "signal-1\n")
        check("the label file is read when the env is empty", host_label(root) == ("signal-1", None))
    finally:
        if saved is None:
            os.environ.pop("MONITORING_HOST_LABEL", None)
        else:
            os.environ["MONITORING_HOST_LABEL"] = saved


if __name__ == "__main__":
    if sys.argv[1:2] == ["--self-test"]:
        sys.exit(self_test())
    if sys.argv[1:2] == ["--derive-floor"] and len(sys.argv) > 2:
        with open(sys.argv[2], encoding="utf-8") as fh:
            print(json.dumps(floor_from_index(json.load(fh)), sort_keys=True))
        sys.exit(0)
    sys.exit(main(sys.argv[1:]))

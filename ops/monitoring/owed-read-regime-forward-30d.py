#!/usr/bin/env python3
"""owed-read-regime-forward-30d.py — EDGE-REGIME-FORWARD-W1 (ARC-REGIME-ACCURACY T5). Snapshot the served labels.

Owner wave: EDGE-REGIME-FORWARD-W1. Registration: audits/regime-forward-preregistration-2026-11-18.md.
T5 scores the regime labels production SERVED (regime_snapshots, the rows scan_market_regimes and pre_trade_check
read) on bars after T3's registration. This read is the host half of plan (b): once, on or after not_before, it
copies the registered window's rows into ONE directory and checks them. It computes no outcome and reads no price:
the scoring runs later on the Mac (src/scripts/regime-forward/forward-run.ts), which verifies these files against the
sha256 this read records, so the bytes scored are the bytes read here.

    OWED_READ_METRICS=<json object, <= 4 KiB>
    OWED_READ_VERDICT=PASS|FAIL|INDETERMINATE

── WHAT IS READ — one psql bundle, ONE `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction, aoe_readonly,
   every SELECT streamed through psql's cursor (FETCH_COUNT 50000): no side holds the whole result; each cursor is
   planned for its whole result (cursor_tuple_fraction 1.0), as the measured plans were; psql is bounded inside the
   container 60 s before the read's deadline (timeout -s KILL), the read kills its docker exec client at the deadline
   even while the stream stalls, and the server ends a session idle in its transaction (120 s) ──
  COUNTS     rows per exchange × timeframe × rule_version in the window predicate
  CHECKS     regime_since_ms against its own label runs (src/scripts/regime-snapshot-sampler.ts: carried while the
             label holds, reset to bar_close_ms on a change, NULL after a hole or a rule change)
  SNAPSHOTS  the 14 columns of every regime_snapshots row in the window predicate
  RUNS       regime_snapshot_runs of the window's bars
  CALLS      labelled get_market_regime rows in [W0, W1), caller hashed on the host (label parity only)
  window predicate: bar_close_ms >= W0 and < W1 + 14 bars of the row's timeframe.

── VERDICT ──
  PASS           the snapshot was written and every check recorded (counts equal the transaction's own counts)
  FAIL           an integrity break of the producer: a rule-version-2 row whose regime_since_ms contradicts its own run
  INDETERMINATE  before not_before, anchors not this read's, a sandbox run with no out_dir, psql failed, the token is
                 not a read-only repeatable-read aoe_readonly session, a section missing or short, a row outside the
                 window predicate, an empty window, or a file that could not be written. Retried hourly to expiry.

    owed-read-regime-forward-30d.py --run --now EPOCH [--sandbox] < anchors.json   (the runner)
    owed-read-regime-forward-30d.py --self-test
Stdlib only.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import select
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

# ── the registration (never retuned by a registry row) ──
WAVE = "EDGE-REGIME-FORWARD-W1"
READ_ID = "regime-forward-30d"
W0_MS = 1_794_816_000_000            # 2026-11-16T08:00:00Z
W1_MS = 1_797_408_000_000            # 2026-12-16T08:00:00Z
LOOKAHEAD_BARS = 14
RULE_VERSION = 2
TF_MS = (("1h", 3_600_000), ("4h", 14_400_000), ("1d", 86_400_000))
NOT_BEFORE_S = 1_798_617_600         # 2026-12-30T08:00:00Z = W1 + 14 days
CALLS_FROM = "2026-11-16T08:00:00"
CALLS_TO = "2026-12-16T08:00:00"
CALLER_DOMAIN = "regime-forward-v1:"
VENUES = ("BINANCE", "BYBIT", "OKX", "BITGET")
ANCHOR_KEYS = ("w0_ms", "w1_ms", "lookahead_bars", "rule_version")
OUT_DIR = "/var/lib/algovault-monitoring/regime-forward-30d"
FILES = ("snapshots.psv.gz", "runs.psv", "calls.psv")

PSQL_TIMEOUT_S = 1400
STATEMENT_TIMEOUT = "900s"
IDLE_IN_TX_TIMEOUT = "120s"


def psql_cmd(timeout_s=PSQL_TIMEOUT_S):
    """The host's psql, bounded where it runs (re-check N3): `timeout -s KILL` inside the container ends psql itself
    60 s before the read's deadline, which kills only its own `docker exec` client."""
    return ("docker exec -i crypto-quant-signal-mcp-postgres-1 timeout -s KILL %d psql -X -U aoe_readonly "
            "-d signal_performance -q -tA -F | -v ON_ERROR_STOP=1" % max(1, timeout_s - 60))


PSQL_CMD = psql_cmd()
FETCH_COUNT = 50_000

SNAP_COLS = ("exchange", "timeframe", "coin", "bar_close_ms", "regime", "confidence", "trend_strength", "adx",
             "adx_slope", "volatility_ratio", "price_structure", "regime_since_ms", "rule_version", "computed_at")
RUN_COLS = ("exchange", "timeframe", "bar_close_ms", "tick_at", "disposition", "universe_n", "written_n",
            "too_new_n", "window_stale_n", "skipped_n", "errors_n", "finished_at")
CALL_COLS = ("timestamp", "exchange", "timeframe", "asset", "regime", "verdict", "lane", "caller")
COUNT_COLS = ("exchange", "timeframe", "rule_version", "rows")
CHECK_COLS = ("exchange", "timeframe", "rule_version", "rows", "carry_bad", "reset_bad", "null_bad", "after_bar")
SECTIONS = ("counts", "checks", "snapshots", "runs", "calls")
BANNED_SQL = re.compile(r"\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|COPY|VACUUM|LOCK|CALL)\b",
                        re.IGNORECASE)

VERDICTS = ("PASS", "FAIL", "INDETERMINATE")
EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
METRICS_MAX_BYTES = 4096
TF_OF = dict(TF_MS)


def utc_iso(epoch_s):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch_s))


def window_end_ms(tf):
    return W1_MS + LOOKAHEAD_BARS * TF_OF[tf]


def in_window(tf, bar_ms):
    """The registered predicate, restated for the row-level check of what psql returned."""
    return tf in TF_OF and W0_MS <= bar_ms < window_end_ms(tf)


def predicate():
    ors = " OR ".join("(timeframe = '%s' AND bar_close_ms < %d)" % (tf, window_end_ms(tf)) for tf, _ in TF_MS)
    return "bar_close_ms >= %d AND (%s)" % (W0_MS, ors)


# ── the bundle ───────────────────────────────────────────────────────────────────────────────

def build_bundle():
    p = predicate()
    iv = "CASE timeframe WHEN '1h' THEN 3600000 WHEN '4h' THEN 14400000 ELSE 86400000 END::bigint"
    # CHECKS reads one day further back so each window row is judged against its real predecessor.
    inner = ("SELECT exchange, timeframe, coin, bar_close_ms AS b, regime, regime_since_ms AS rs, rule_version AS rv, "
             "%s AS iv, lag(bar_close_ms) OVER w AS pb, lag(regime) OVER w AS pr, lag(regime_since_ms) OVER w AS prs, "
             "lag(rule_version) OVER w AS prv FROM regime_snapshots WHERE bar_close_ms >= %d AND (%s) "
             "WINDOW w AS (PARTITION BY exchange, timeframe, coin ORDER BY bar_close_ms)"
             % (iv, W0_MS - 86_400_000, p.split(" AND ", 1)[1]))
    lines = [
        "\\set ON_ERROR_STOP on",
        # psql reads every SELECT through a cursor, FETCH_COUNT rows at a time: neither psql nor the server holds the
        # whole SNAPSHOTS result (CH3 F14; audit lesson 13).
        "\\set FETCH_COUNT %d" % FETCH_COUNT,
        "SET statement_timeout = '%s';" % STATEMENT_TIMEOUT,
        "SET TIME ZONE 'UTC';",
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
        "SELECT 'MARK|ro|' || current_user || '|' || current_setting('transaction_read_only') || '|' || "
        "current_setting('transaction_isolation');",
        "SET LOCAL work_mem = '256MB';",
        "SET LOCAL max_parallel_workers_per_gather = 0;",
        # a cursor is planned for its whole result, as the plain statements of the measured plans were (re-check R5)
        "SET LOCAL cursor_tuple_fraction = 1.0;",
        # a session whose client stops reading between fetches ends on the server (re-check N3)
        "SET LOCAL idle_in_transaction_session_timeout = '%s';" % IDLE_IN_TX_TIMEOUT,
        "SELECT 'MARK|sec|counts';",
        "SELECT exchange, timeframe, rule_version, count(*) FROM regime_snapshots WHERE %s "
        "GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;" % p,
        "SELECT 'MARK|sec|checks';",
        "SELECT exchange, timeframe, rv, count(*), "
        "count(*) FILTER (WHERE pb = b - iv AND prv = rv AND pr = regime AND rs IS DISTINCT FROM prs), "
        "count(*) FILTER (WHERE pb = b - iv AND prv = rv AND pr <> regime AND rs IS DISTINCT FROM b), "
        "count(*) FILTER (WHERE (pb IS NULL OR pb <> b - iv OR prv <> rv) AND rs IS NOT NULL), "
        "count(*) FILTER (WHERE rs > b) "
        "FROM (%s) s WHERE b >= %d GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;" % (inner, W0_MS),
        "SELECT 'MARK|sec|snapshots';",
        "SELECT %s FROM regime_snapshots WHERE %s;" % (", ".join(SNAP_COLS), p),
        "SELECT 'MARK|sec|runs';",
        "SELECT %s FROM regime_snapshot_runs WHERE bar_close_ms >= %d AND bar_close_ms < %d ORDER BY 1, 2, 3, 4;"
        % (", ".join(RUN_COLS), W0_MS, window_end_ms("1d")),
        "SELECT 'MARK|sec|calls';",
        "SELECT \"timestamp\", %s, "
        "CASE WHEN license_tier = 'internal' AND client_name = 'python-httpx' THEN 'BOT' "
        "WHEN license_tier = 'internal' THEN 'OWN' ELSE 'EXTERNAL' END, "
        "left(md5('%s' || coalesce(ip_hash, '') || '|' || coalesce(client_name, '')), 12) "
        "FROM request_log WHERE tool_name = 'get_market_regime' AND regime IS NOT NULL "
        "AND \"timestamp\" >= '%s' AND \"timestamp\" < '%s' ORDER BY \"timestamp\", id;"
        % (", ".join("regexp_replace(coalesce(%s, ''), '[^A-Za-z0-9._:-]', '?', 'g')" % c
                     for c in ("exchange", "timeframe", "asset", "regime", "verdict")),
           CALLER_DOMAIN, CALLS_FROM, CALLS_TO),
        "SELECT 'MARK|end';",
        "COMMIT;",
    ]
    return "\n".join(lines) + "\n"


# ── the sink: one pass over psql's stdout, files written beside their tallies ─────────────────

class Sink:
    """Consumes the bundle's output line by line. Data lines go to `<file>.part` in `out_dir`; nothing replaces a
    final name until `finish()` has judged the whole read."""

    def __init__(self, out_dir):
        self.out_dir = out_dir
        self.sec = None
        self.order = []
        self.ro = None
        self.ended = False
        self.err = None
        self.counts = {}      # (ex, tf, rv) -> rows, from COUNTS
        self.checks = []      # CHECK rows as dicts
        self.seen = {}        # (ex, tf, rv) -> rows streamed in SNAPSHOTS
        self.coins = {}       # (ex, tf) -> set of coins
        self.bars = {}        # (ex, tf) -> set of bars
        self.runs_bad = {}    # (ex, tf) -> bars whose run is not COMPLETE / WINDOW_STALE (NOT_DUE ignored)
        self.runs_ok = {}
        self.calls = {}       # exchange -> labelled calls
        self.rows = {f: 0 for f in FILES}
        self.hash = {f: hashlib.sha256() for f in FILES}
        self.bytes = {f: 0 for f in FILES}
        self._open()

    def _part(self, f):
        return os.path.join(self.out_dir, f + ".part")

    def _open(self):
        self._raw = {f: open(self._part(f), "wb") for f in FILES}
        self._gz = gzip.GzipFile(filename="", mode="wb", fileobj=self._raw["snapshots.psv.gz"], mtime=0)
        self._write("snapshots.psv.gz", "|".join(SNAP_COLS), header=True)
        self._write("runs.psv", "|".join(RUN_COLS), header=True)
        self._write("calls.psv", "|".join(CALL_COLS), header=True)

    def _write(self, f, line, header=False):
        data = (line + "\n").encode("utf-8")
        if f == "snapshots.psv.gz":
            self._gz.write(data)
        else:
            self._raw[f].write(data)
        if not header:
            self.rows[f] += 1

    def fail(self, why):
        if self.err is None:
            self.err = why

    def feed(self, line):
        if self.err is not None:
            return
        if line.startswith("MARK|"):
            parts = line.split("|")
            if parts[1] == "ro":
                self.ro = parts[2:]
            elif parts[1] == "sec" and len(parts) == 3:
                self.sec = parts[2]
                self.order.append(parts[2])
            elif parts[1] == "end":
                self.ended, self.sec = True, None
            else:
                self.fail("an unknown marker %r" % line[:60])
            return
        if line == "":
            return
        f = line.split("|")
        if self.sec == "counts":
            if len(f) != len(COUNT_COLS):
                return self.fail("a COUNTS row has %d fields" % len(f))
            self.counts[(f[0], f[1], f[2])] = int(f[3])
        elif self.sec == "checks":
            if len(f) != len(CHECK_COLS):
                return self.fail("a CHECKS row has %d fields" % len(f))
            self.checks.append(dict(zip(CHECK_COLS, f[:3] + [int(x) for x in f[3:]])))
        elif self.sec == "snapshots":
            if len(f) != len(SNAP_COLS):
                return self.fail("a SNAPSHOTS row has %d fields" % len(f))
            ex, tf, coin, bar, rv = f[0], f[1], f[2], f[3], f[12]
            if not bar.isdigit() or not in_window(tf, int(bar)):
                return self.fail("a SNAPSHOTS row lies outside the registered window: %s/%s bar %s" % (ex, tf, bar[:16]))
            k = (ex, tf, rv)
            self.seen[k] = self.seen.get(k, 0) + 1
            self.coins.setdefault((ex, tf), set()).add(coin)
            self.bars.setdefault((ex, tf), set()).add(bar)
            self._write("snapshots.psv.gz", line)
        elif self.sec == "runs":
            if len(f) != len(RUN_COLS):
                return self.fail("a RUNS row has %d fields" % len(f))
            if f[4] != "NOT_DUE":
                d = self.runs_ok if f[4] in ("COMPLETE", "WINDOW_STALE") else self.runs_bad
                d.setdefault((f[0], f[1]), set()).add(f[2])
            self._write("runs.psv", line)
        elif self.sec == "calls":
            if len(f) != len(CALL_COLS):
                return self.fail("a CALLS row has %d fields" % len(f))
            self.calls[f[1]] = self.calls.get(f[1], 0) + 1
            self._write("calls.psv", line)
        else:
            self.fail("a data line outside any section")

    def close_parts(self):
        try:
            self._gz.close()
        finally:
            for fh in self._raw.values():
                fh.close()

    def discard(self):
        for f in FILES:
            try:
                os.unlink(self._part(f))
            except OSError:
                pass

    def judge(self):
        """-> (verdict, reason). Called after psql exited 0 and the parts are closed."""
        if self.err:
            return "INDETERMINATE", self.err
        if not self.ro or self.ro != ["aoe_readonly", "on", "repeatable read"]:
            return "INDETERMINATE", "the session token is %r, not aoe_readonly / read only / repeatable read" % (self.ro,)
        if self.order != list(SECTIONS) or not self.ended:
            return "INDETERMINATE", "sections %s, end=%s: a short or reordered read" % (",".join(self.order), self.ended)
        if self.seen != self.counts:
            return "INDETERMINATE", "the streamed rows differ from the transaction's own COUNTS"
        if sum(self.counts.values()) == 0:
            return "INDETERMINATE", "the window holds no snapshot row: nothing was verified"
        breaks = {k: sum(c[k] for c in self.checks if c["rule_version"] == str(RULE_VERSION))
                  for k in ("carry_bad", "reset_bad", "null_bad", "after_bar")}
        if any(breaks.values()):
            return "FAIL", "regime_since_ms contradicts its own runs on rule-version-%d rows: %s" % (RULE_VERSION, breaks)
        return "PASS", "snapshot written and checked"

    def metrics(self):
        venues = {}
        for (ex, tf, rv), n in sorted(self.counts.items()):
            v = venues.setdefault(ex, {}).setdefault(tf, {"rows": 0, "other_rv": 0})
            v["rows"] += n
            if rv != str(RULE_VERSION):
                v["other_rv"] += n
        for (ex, tf), cs in self.coins.items():
            venues[ex][tf]["coins"] = len(cs)
            venues[ex][tf]["bars"] = len(self.bars[(ex, tf)])
        for (ex, tf), bs in self.runs_bad.items():
            bad = len(bs - self.runs_ok.get((ex, tf), set()))
            if bad:
                venues.setdefault(ex, {}).setdefault(tf, {"rows": 0, "other_rv": 0})["runs_not_complete"] = bad
        checks = {k: sum(c[k] for c in self.checks) for k in ("rows", "carry_bad", "reset_bad", "null_bad", "after_bar")}
        return {"venues": venues, "regime_since": checks, "calls": dict(sorted(self.calls.items())),
                "other_venues": sorted({ex for ex, _, _ in self.counts} - set(VENUES))}


def write_atomically(out_dir, sink):
    """Hashes each closed part, then replaces the final names: data first, the manifest last. -> files dict."""
    files = {}
    for f in FILES:
        h, n = hashlib.sha256(), 0
        with open(sink._part(f), "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
                n += len(chunk)
        files[f] = {"sha256": h.hexdigest(), "bytes": n, "rows": sink.rows[f]}
    for f in FILES:
        os.replace(sink._part(f), os.path.join(out_dir, f))
    man = os.path.join(out_dir, "manifest.json")
    with open(man + ".part", "w", encoding="utf-8") as fh:
        json.dump({"read_id": READ_ID, "wave": WAVE, "files": files}, fh, sort_keys=True)
    os.replace(man + ".part", man)
    return files


def prepare_dir(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)
    return path


# ── the read ─────────────────────────────────────────────────────────────────────────────────

def resolve(anchors, now, sandbox):
    """-> (out_dir, None) or (None, reason). Nothing is read and nothing is written on a refusal."""
    if not isinstance(anchors, dict):
        return None, "anchors are not a JSON object"
    keys = sorted(k for k in anchors if not str(k).startswith("_"))
    if keys != sorted(ANCHOR_KEYS):
        return None, "anchor keys %s are not %s" % (",".join(keys), ",".join(sorted(ANCHOR_KEYS)))
    want = {"w0_ms": W0_MS, "w1_ms": W1_MS, "lookahead_bars": LOOKAHEAD_BARS, "rule_version": RULE_VERSION}
    if any(anchors[k] != v for k, v in want.items()):
        return None, "the registry's anchors differ from this read's registration"
    if type(now) is not int or now < NOT_BEFORE_S:
        return None, "now=%s is before not_before %s: no row is read before it" % (now, utc_iso(NOT_BEFORE_S))
    if sandbox:
        o = (anchors.get("_sandbox_overrides") or {}).get("out_dir")
        if not isinstance(o, str) or not os.path.isabs(o) or os.path.abspath(o) == OUT_DIR:
            return None, "a sandbox run needs an absolute out_dir override other than %s" % OUT_DIR
        return o, None
    return OUT_DIR, None


def stream_psql(sql, sink, cmd=None, timeout_s=PSQL_TIMEOUT_S):
    """Runs the bundle, feeding stdout to the sink line by line, all within one deadline. -> reason or None.

    stderr goes to a file, so psql never blocks on it; stdout is read only when select() says it is readable, and the
    deadline is checked between reads, so a stream that stalls is killed at the deadline (review LOW). What is killed
    is this process's child — `docker exec`, not psql in the container, which its own `timeout` bounds (psql_cmd).
    The child is killed on every exit path, an exception included (re-check N3)."""
    cmd = psql_cmd(timeout_s) if cmd is None else cmd
    deadline = time.monotonic() + timeout_s
    with tempfile.TemporaryFile() as errf:
        try:
            p = subprocess.Popen(shlex.split(cmd), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errf)
        except OSError as e:
            return "psql could not start: %s" % e

        def killed():
            p.kill()
            p.wait()
            return "psql did not finish within %ds: killed" % timeout_s

        try:
            try:
                p.stdin.write(sql.encode("utf-8"))
                p.stdin.close()
            except BrokenPipeError:
                pass
            fd, buf = p.stdout.fileno(), b""
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    return killed()
                ready, _, _ = select.select([fd], [], [], min(left, 5.0))
                if not ready:
                    continue
                chunk = os.read(fd, 1 << 16)
                if not chunk:
                    break
                buf += chunk
                *lines, buf = buf.split(b"\n")
                for line in lines:
                    sink.feed(line.rstrip(b"\r").decode("utf-8", "replace"))
            if buf:
                sink.feed(buf.rstrip(b"\r").decode("utf-8", "replace"))
            p.stdout.close()
            try:
                rc = p.wait(timeout=max(0.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                return killed()
        finally:
            if p.poll() is None:
                p.kill()
                p.wait()
        errf.seek(0)
        err = errf.read().decode("utf-8", "replace")
    return None if rc == 0 else "psql rc=%d: %s" % (rc, err.strip()[:240])


def run(now, anchors, sandbox=False, cmd=None, timeout_s=PSQL_TIMEOUT_S):
    base = {"read_at": utc_iso(now) if type(now) is int else None, "window": {"w0_ms": W0_MS, "w1_ms": W1_MS,
            "lookahead_bars": LOOKAHEAD_BARS, "rule_version": RULE_VERSION}}
    out_dir, why = resolve(anchors, now, sandbox)
    if why:
        return "INDETERMINATE", dict(base, reason=why, psql_invoked=False)
    try:
        prepare_dir(out_dir)
        sink = Sink(out_dir)
    except OSError as e:
        return "INDETERMINATE", dict(base, reason="the snapshot directory is not writable: %s" % e, psql_invoked=False)
    try:
        why = stream_psql(build_bundle(), sink, cmd, timeout_s)
    finally:
        sink.close_parts()
    if why:
        sink.discard()
        return "INDETERMINATE", dict(base, reason=why, psql_invoked=True)
    verdict, reason = sink.judge()
    m = dict(base, reason=reason, psql_invoked=True, **sink.metrics())
    if verdict == "INDETERMINATE":
        sink.discard()
        return verdict, m
    try:
        m["files"] = write_atomically(out_dir, sink)
        m["out_dir"] = out_dir
    except OSError as e:
        sink.discard()
        return "INDETERMINATE", dict(m, reason="the snapshot could not be written: %s" % e)
    return verdict, m


def emit(verdict, metrics):
    text = json.dumps(metrics, sort_keys=True, separators=(",", ":"))
    if len(text.encode("utf-8")) > METRICS_MAX_BYTES:
        metrics = {k: metrics[k] for k in ("reason", "read_at", "files", "out_dir", "regime_since") if k in metrics}
        metrics["_trimmed"] = "venue tallies dropped to fit 4 KiB; the manifest beside the files carries the rows"
        text = json.dumps(metrics, sort_keys=True, separators=(",", ":"))
    return ["OWED_READ_METRICS=" + text, "OWED_READ_VERDICT=" + verdict]


def main(argv=None):
    ap = argparse.ArgumentParser(description="owed read: regime-forward-30d")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--now", type=int)
    ap.add_argument("--sandbox", action="store_true")
    a = ap.parse_args(sys.argv[1:] if argv is None else argv)
    if a.self_test:
        return self_test()
    if not a.run or a.now is None:
        ap.error("the runner invokes --run --now EPOCH with the anchors on stdin")
    try:
        anchors = json.loads(sys.stdin.read() or "null")
        verdict, metrics = run(a.now, anchors, a.sandbox)
    except Exception as e:  # noqa: BLE001 — an unexpected fault verified nothing
        verdict, metrics = "INDETERMINATE", {"reason": "fault %s: %s" % (type(e).__name__, str(e)[:200])}
    for ln in emit(verdict, metrics):
        print(ln)
    return EXIT_FOR[verdict]


# ── Self-test (hermetic: a stub psql prints a synthetic bundle; files go to a temp directory) ──────

_SELF_TEST_MIN_CHECKS = 36


def _fixture(break_since=False, short=False, drop_end=False, token="aoe_readonly|on|repeatable read",
             outside=False, empty=False):
    b0 = W0_MS
    snaps = [] if empty else [
        "BINANCE|1h|T5Q001Z|%d|TRENDING_UP|62|MODERATE|31.2|0.4|0.0123|HIGHER_HIGHS|%d|2|%d" % (b0, b0 - 3_600_000, b0 + 60_000),
        "BINANCE|1h|T5Q001Z|%d|TRENDING_UP|64|MODERATE|32.0|0.5|0.0120|HIGHER_HIGHS|%d|2|%d"
        % (b0 + 3_600_000, b0 - 3_600_000, b0 + 3_660_000),
        "OKX|1d|T5Q002Z|%d|RANGING|40|WEAK||0.1|0.0300|NEUTRAL||2|%d" % (b0 + 8 * 3_600_000, b0 + 8 * 3_600_000 + 60_000),
    ]
    if outside:
        snaps.append("BYBIT|1h|T5Q003Z|%d|RANGING|40|WEAK|10|0|0.01|NEUTRAL||2|1" % (W1_MS + 14 * 3_600_000))
    counts = {}
    for s in snaps:
        f = s.split("|")
        counts[(f[0], f[1], f[12])] = counts.get((f[0], f[1], f[12]), 0) + 1
    if short and counts:
        k = next(iter(counts))
        counts[k] += 1
    out = ["MARK|ro|" + token, "MARK|sec|counts"]
    out += ["%s|%s|%s|%d" % (k[0], k[1], k[2], n) for k, n in sorted(counts.items())]
    out += ["MARK|sec|checks", "BINANCE|1h|2|2|%d|0|0|0" % (1 if break_since else 0), "OKX|1d|2|1|0|0|0|0",
            "MARK|sec|snapshots"] + snaps
    out += ["MARK|sec|runs", "BINANCE|1h|%d|%d|COMPLETE|2|2|0|0|0|0|%d" % (b0, b0 + 1, b0 + 2),
            "OKX|1d|%d|%d|PARTIAL|2|1|0|0|0|0|%d" % (b0 + 8 * 3_600_000, b0 + 1, b0 + 2),
            "MARK|sec|calls", "2026-11-16T09:00:01.000Z|BINANCE|4h|T5Q001Z|TRENDING_UP|OK|EXTERNAL|0123456789ab"]
    if not drop_end:
        out.append("MARK|end")
    return "\n".join(out) + "\n"


def _stub(d, text, rc=0, stall_s=0, stderr_bytes=0):
    """A psql stand-in: drains stdin, writes stderr_bytes to stderr, prints the fixture (with stall_s, only its first
    line, then sleeps), exits rc. Its pid goes to psql-stub.pid."""
    fx = os.path.join(d, "fixture.txt")
    with open(fx, "w", encoding="utf-8") as fh:
        fh.write(text)
    st = os.path.join(d, "psql-stub.py")
    body = ["import os, sys, time", "open(%r, 'w').write(str(os.getpid()))" % os.path.join(d, "psql-stub.pid"),
            "sys.stdin.read()", "sys.stderr.write('e' * %d)" % stderr_bytes, "sys.stderr.flush()", "t = open(%r).read()" % fx]
    if stall_s:
        body += ["sys.stdout.write(t.splitlines(True)[0])", "sys.stdout.flush()", "time.sleep(%d)" % stall_s]
    body += ["sys.stdout.write(t)", "sys.exit(%d)" % rc]
    with open(st, "w", encoding="utf-8") as fh:
        fh.write("\n".join(body) + "\n")
    return "%s %s" % (shlex.quote(sys.executable), shlex.quote(st))


def _alive(pid_file):
    try:
        os.kill(int(open(pid_file).read()), 0)
        return True
    except (OSError, ValueError):
        return False


def self_test():
    failures, ran = [], []

    def check(name, fn):
        ran.append(name)
        try:
            ok = fn()
        except Exception as e:  # noqa: BLE001 — an assertion that raises is a crash, not a verdict
            failures.append(name)
            print("  [FAIL] %s (raised %s: %s)" % (name, type(e).__name__, str(e)[:160]))
            return
        if not ok:
            failures.append(name)
        print("  [%s] %s" % ("ok" if ok else "FAIL", name))

    A = {"w0_ms": W0_MS, "w1_ms": W1_MS, "lookahead_bars": LOOKAHEAD_BARS, "rule_version": RULE_VERSION}
    NOW = NOT_BEFORE_S + 60
    root = tempfile.mkdtemp(prefix="owed-read-regime-forward-")
    try:
        def go(text, now=NOW, anchors=None, rc=0, tag="x", stall_s=0, stderr_bytes=0, timeout_s=PSQL_TIMEOUT_S):
            d = os.path.join(root, tag)
            os.makedirs(d, exist_ok=True)
            out = os.path.join(d, "out")
            a = dict(anchors if anchors is not None else A, _sandbox_overrides={"out_dir": out})
            v, m = run(now, a, sandbox=True, cmd=_stub(d, text, rc, stall_s, stderr_bytes), timeout_s=timeout_s)
            return v, m, out

        # ── the registered constants ──
        check("W0 and W1 are the registered instants",
              lambda: utc_iso(W0_MS // 1000) == "2026-11-16T08:00:00Z" and utc_iso(W1_MS // 1000) == "2026-12-16T08:00:00Z")
        check("not_before is W1 + 14 days = 2026-12-30T08:00:00Z",
              lambda: NOT_BEFORE_S == W1_MS // 1000 + 14 * 86_400 and utc_iso(NOT_BEFORE_S) == "2026-12-30T08:00:00Z")
        check("the window ends 14 bars after W1 at each timeframe",
              lambda: [utc_iso(window_end_ms(t) // 1000) for t, _ in TF_MS]
              == ["2026-12-16T22:00:00Z", "2026-12-18T16:00:00Z", "2026-12-30T08:00:00Z"])
        # ── the bundle ──
        sql = build_bundle()
        check("one READ ONLY repeatable-read transaction, token first",
              lambda: sql.count("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;") == 1 and sql.count("COMMIT;") == 1
              and sql.index("MARK|ro|") < sql.index("MARK|sec|counts"))
        check("the bundle carries no write, grant, copy or lock token", lambda: BANNED_SQL.search(sql) is None)
        check("psql streams every SELECT in batches: FETCH_COUNT 50000 is set before the transaction's first SELECT",
              lambda: sql.count("\\set FETCH_COUNT 50000\n") == 1
              and sql.index("\\set FETCH_COUNT 50000") < sql.index("BEGIN ISOLATION LEVEL") < sql.index("SELECT "))
        check("each cursor is planned for its whole result: cursor_tuple_fraction 1.0 is SET LOCAL inside the transaction, "
              "before its first data SELECT",
              lambda: sql.count("SET LOCAL cursor_tuple_fraction = 1.0;\n") == 1
              and sql.index("BEGIN ISOLATION LEVEL") < sql.index("SET LOCAL cursor_tuple_fraction") < sql.index("MARK|sec|counts"))
        check("aoe_readonly through docker exec -i", lambda: shlex.split(PSQL_CMD)[:4]
              == ["docker", "exec", "-i", "crypto-quant-signal-mcp-postgres-1"] and "-U aoe_readonly" in PSQL_CMD)
        # ── what the deadline stops (re-check N3) ──
        check("psql is bounded inside the container, below the deadline: timeout -s KILL (deadline - 60 s) runs psql",
              lambda: shlex.split(PSQL_CMD)[4:9] == ["timeout", "-s", "KILL", str(PSQL_TIMEOUT_S - 60), "psql"]
              and shlex.split(psql_cmd(2))[4:9] == ["timeout", "-s", "KILL", "1", "psql"])
        check("a session whose client stops reading ends on the server: idle_in_transaction_session_timeout is SET LOCAL "
              "inside the transaction, beside cursor_tuple_fraction",
              lambda: sql.count("SET LOCAL idle_in_transaction_session_timeout = '%s';\n" % IDLE_IN_TX_TIMEOUT) == 1
              and sql.index("BEGIN ISOLATION LEVEL") < sql.index("SET LOCAL idle_in_transaction_session_timeout")
              < sql.index("MARK|sec|counts"))
        check("COUNTS and SNAPSHOTS read the one registered predicate",
              lambda: sql.count(predicate()) == 2 and "bar_close_ms >= 1794816000000" in predicate())
        check("the caller is hashed on the host; no raw ip_hash, user_agent or client_name column leaves",
              lambda: "left(md5('regime-forward-v1:' || coalesce(ip_hash" in sql and "user_agent" not in sql
              and ", ip_hash," not in sql)
        check("the calls window is [W0, W1)", lambda: "'2026-11-16T08:00:00'" in sql and "'2026-12-16T08:00:00'" in sql)
        check("the in-row window check equals the predicate at its edges",
              lambda: in_window("1h", W0_MS) and not in_window("1h", W0_MS - 1) and not in_window("1h", window_end_ms("1h"))
              and in_window("1d", window_end_ms("1d") - 1) and not in_window("5m", W0_MS))
        # ── refusals read nothing and write nothing ──
        v, m, out = go(_fixture(), now=NOT_BEFORE_S - 1, tag="early")
        check("before not_before: INDETERMINATE, psql never invoked, no directory",
              lambda: v == "INDETERMINATE" and m["psql_invoked"] is False and not os.path.exists(out))
        v, m, out = go(_fixture(), anchors=dict(A, lookahead_bars=7), tag="anchors")
        check("anchors that differ from the registration: INDETERMINATE, psql never invoked",
              lambda: v == "INDETERMINATE" and m["psql_invoked"] is False and not os.path.exists(out))
        check("a sandbox run with no out_dir override is refused",
              lambda: resolve(dict(A), NOW, True)[0] is None and resolve(dict(A, _sandbox_overrides={"out_dir": OUT_DIR}), NOW, True)[0] is None)
        check("production writes only the registered directory", lambda: resolve(dict(A), NOW, False) == (OUT_DIR, None))
        # ── the happy path ──
        v, m, out = go(_fixture(), tag="ok")
        check("a consistent snapshot: PASS", lambda: v == "PASS")
        check("the directory is 0700", lambda: (os.stat(out).st_mode & 0o777) == 0o700)
        check("every file is written, no part left",
              lambda: sorted(os.listdir(out)) == sorted(list(FILES) + ["manifest.json"]))
        check("each recorded sha256 is the file's bytes",
              lambda: all(hashlib.sha256(open(os.path.join(out, f), "rb").read()).hexdigest() == m["files"][f]["sha256"]
                          for f in FILES))
        check("rows recorded: 3 snapshots, 2 runs, 1 call",
              lambda: [m["files"][f]["rows"] for f in FILES] == [3, 2, 1])
        check("the gzip holds the header and the rows verbatim",
              lambda: gzip.open(os.path.join(out, "snapshots.psv.gz"), "rt").read().splitlines()[0] == "|".join(SNAP_COLS))
        check("tallies: venue × timeframe rows, coins, bars, and the bar whose run is not complete",
              lambda: m["venues"]["BINANCE"]["1h"] == {"rows": 2, "other_rv": 0, "coins": 1, "bars": 2}
              and m["venues"]["OKX"]["1d"]["runs_not_complete"] == 1)
        check("the metrics line fits 4 KiB", lambda: len(emit(v, m)[0].encode()) <= len("OWED_READ_METRICS=") + METRICS_MAX_BYTES)
        # ── FAIL and INDETERMINATE ──
        v, m, out = go(_fixture(break_since=True), tag="since")
        check("a regime_since contradiction on rule-version-2 rows: FAIL, and the snapshot is still written",
              lambda: v == "FAIL" and os.path.exists(os.path.join(out, "manifest.json")))
        v, m, out = go(_fixture(short=True), tag="short")
        check("streamed rows differ from COUNTS: INDETERMINATE, nothing replaced",
              lambda: v == "INDETERMINATE" and not os.path.exists(os.path.join(out, "manifest.json"))
              and not any(n.endswith(".part") for n in os.listdir(out)))
        v, m, out = go(_fixture(drop_end=True), tag="noend")
        check("no end marker: INDETERMINATE", lambda: v == "INDETERMINATE")
        v, m, out = go(_fixture(token="algovault_app|off|read committed"), tag="token")
        check("a session that is not aoe_readonly / read only / repeatable read: INDETERMINATE",
              lambda: v == "INDETERMINATE" and "token" in m["reason"])
        v, m, out = go(_fixture(outside=True), tag="outside")
        check("a row outside the registered window: INDETERMINATE, never written as data",
              lambda: v == "INDETERMINATE" and "outside the registered window" in m["reason"]
              and not os.path.exists(os.path.join(out, "snapshots.psv.gz")))
        v, m, out = go(_fixture(empty=True), tag="empty")
        check("an empty window verified nothing: INDETERMINATE", lambda: v == "INDETERMINATE" and "no snapshot row" in m["reason"])
        v, m, out = go(_fixture(), rc=2, tag="rc")
        check("psql exits non-zero: INDETERMINATE", lambda: v == "INDETERMINATE" and m["reason"].startswith("psql rc=2"))
        # ── the deadline (review LOW) ──
        t0 = time.monotonic()
        v, m, out = go(_fixture(), tag="stall", stall_s=600, timeout_s=2)
        took = time.monotonic() - t0
        check("a psql whose stream stalls is killed at the deadline: INDETERMINATE, the process gone, nothing replaced",
              lambda: v == "INDETERMINATE" and m["reason"] == "psql did not finish within 2s: killed" and took < 20
              and not _alive(os.path.join(root, "stall", "psql-stub.pid"))
              and not os.path.exists(os.path.join(out, "manifest.json")))
        d = os.path.join(root, "raise")
        os.makedirs(d)

        class _Raising:
            def feed(self, line):
                raise ValueError("the sink raised")
        try:
            stream_psql("SELECT 1;", _Raising(), _stub(d, _fixture(), stall_s=600), 60)
            raised = False
        except ValueError:
            raised = True
        check("an exception inside the stream leaves no live psql: the child is killed on every exit path",
              lambda: raised and not _alive(os.path.join(d, "psql-stub.pid")))
        v, m, out = go(_fixture(), tag="stderr", stderr_bytes=1 << 20, timeout_s=60)
        check("a psql that writes a megabyte to stderr before its rows does not block: PASS within the deadline",
              lambda: v == "PASS")
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print("self-test: %d checks, %d failed" % (len(ran), len(failures)))
    if len(ran) < _SELF_TEST_MIN_CHECKS:
        print("self-test: FAIL — only %d checks ran (floor %d)" % (len(ran), _SELF_TEST_MIN_CHECKS))
        failures.append("floor")
    if failures:
        print("SELF_TEST_VERDICT=FAIL — %d of %d checks failed" % (len(failures), len(ran)))
        return 1
    print("SELF_TEST_VERDICT=PASS — %d checks green" % len(ran))
    return 0


if __name__ == "__main__":
    sys.exit(main())

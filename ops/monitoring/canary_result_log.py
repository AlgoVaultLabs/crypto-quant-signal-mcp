#!/usr/bin/env python3
"""canary_result_log.py — OPS-SCORER-CAPTURE-DAY3-HEALTH-READOUT-W1 R6.

THE GENERATOR FIX: make a scheduled on-host canary's structured result readable OFF-HOST.

── THE DEFECT THIS RETIRES ──────────────────────────────────────────────────────────────────
`OPS-SCORER-INPUT-PERSISTENCE-W1` published its running capture counts in exactly one place:
`scorer-input-identity-canary.py`'s stdout on signal-1, daily at 20:37 UTC. That was a CORRECT
decision — the alternative, an HTTP reader on the admin-gated confidence-bands endpoint, would
have put a reference to that wave's quarantined store inside `src/index.ts`, which its own
firewall exists to refuse. But it left the scheduled day-3 health readout undispatchable: Cowork
has no SSH credential, no reachable checkout, and no HTTP surface, so a recurring check that
depends on those counts could not execute a single probe.

(This module names no table and no column of that store, deliberately: it is generic, and a
prose mention alone would put it inside a firewall it has no business being allowlisted by.)

Stdout in a host logfile is not a data surface. This module is the smallest thing that fixes the
whole class: ONE JSON line per canary run, appended to a bounded file, which the existing
`status.md` push step already syncs — INVERTED, so the record comes back to the vault.

Every scheduled canary on this host inherits it by adding two lines. Named inheritors:
`disk-headroom-canary` · `book-liveness-canary` · `regime-budget-starvation-canary`. This wave
wires exactly ONE consumer (`scorer-input-identity-canary`); the others are a follow-up, per the
3-example-threshold rule. Consumer of the file: `ops/scripts/monitoring-results-sync.sh`.

── THIS IS A RECORDER, NOT A GATE, AND THE DISTINCTION IS LOAD-BEARING ──────────────────────
It emits NO `*_VERDICT=` token of its own and it NEVER raises. A canary's verdict, its exit code
and its alert dispatch must be byte-for-byte identical whether this module succeeds or fails —
otherwise a logging bug becomes a paging bug, and the record would be a second thing that can
take the alarm down.

The verdict-token law still binds its CALLER, though, in one direction: a failure here must not
be silent. `append_result` returns `(ok, detail)` and the caller prints a POSITIVE line either
way — `CANARY_RESULT_LOG=<path> line=<n>` or `CANARY_RESULT_LOG_FAILED=<reason>`. A run that
wrote no record and a run that wrote one must never look the same in the log.

── BOUNDED, BECAUSE AN UNBOUNDED LOG IS THE GROWTH TERM THE DISK CANARY EXISTS TO CATCH ──────
Two independent bounds, both refusals rather than truncations:
  * `MAX_LINE_BYTES` — a pathological metrics dict is REFUSED, never written half-formed.
  * `MAX_LINES`      — the file is trimmed to its most recent N lines, atomically (temp in the
    same directory + `os.replace`), so a reader never observes a partial file.
Trimming DISCARDS the oldest lines on the host. That is safe only because the vault side
UNION-MERGES rather than overwrites (`monitoring-results-sync.sh`), so host-side trimming can
never delete vault history. If that pull is ever changed to a plain copy, this cap becomes data
loss — the two are a pair.

    canary_result_log.py --self-test    # hermetic; no host paths touched
    canary_result_log.py --show-path    # print the resolved results path
"""
from __future__ import annotations

import fcntl
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

# The results file lives beside `sot-parity-streak.jsonl`, the existing JSONL-in-this-directory
# precedent, and inside the directory the status.md push already targets.
RESULTS_PATH = os.environ.get(
    "CANARY_RESULT_LOG_PATH", "/var/lib/algovault-monitoring/canary-results.jsonl"
)

# ~500 days at four canaries a day, ~700 KB. Chosen against the observed line width rather than
# picked round: a record from the widest current caller is ~350 B.
MAX_LINES = int(os.environ.get("CANARY_RESULT_LOG_MAX_LINES", "2000"))

# A single record is a handful of scalars. Anything an order of magnitude past that is a caller
# bug (a whole result set handed in as "metrics"), and writing it would let one run consume the
# entire cap. REFUSE and say so.
MAX_LINE_BYTES = int(os.environ.get("CANARY_RESULT_LOG_MAX_LINE_BYTES", "8192"))

# One host vocabulary across ssh config, the monitoring inventory and cloud labels.
HOST_LABEL = os.environ.get("MONITORING_HOST_LABEL", "signal-1")

# The record's key ORDER is part of its contract: the vault-side merge keys on (canary, at), and
# a stable key order keeps a re-run of the same second byte-identical so the union dedupes it.
RECORD_KEYS = ("at", "host", "canary", "verdict", "exit_code", "metrics")


def utc_now_iso() -> str:
    """Stamped from a clock read AT WRITE TIME, never from a caller-supplied session date.

    A long agent session's sense of "now" drifts from the box's real clock, and a date written
    from that drifted sense is a fabricated timestamp in a durable record.
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_record(
    canary: str,
    verdict: str,
    exit_code: int,
    metrics: dict | None,
    *,
    at: str | None = None,
    host: str | None = None,
) -> str:
    """PURE. Render one record as a single-line JSON string (no trailing newline).

    Extracted because the caller's own hermetic self-test is structurally blind to whatever its
    seam replaces — and here the seam is the filesystem, which makes THIS function and
    `trim_lines` the only code no scenario would otherwise execute. Both have shipped broken in
    this estate before (a `%`-formatted LIKE clause, a left-to-right key split), so both are pure
    and both are asserted directly.

    Raises TypeError/ValueError on an unserialisable subject — `append_result` is the layer that
    converts that into a returned reason. Keeping the failure REAL here is what lets the self-test
    prove the refusal works.
    """
    record = {
        "at": at or utc_now_iso(),
        "host": host or HOST_LABEL,
        "canary": canary,
        "verdict": verdict,
        "exit_code": int(exit_code),
        "metrics": metrics if metrics is not None else {},
    }
    # `allow_nan=False`: a NaN residual would render as bare `NaN`, which is not valid JSON and
    # which every strict parser downstream rejects — including the vault-side merge. Refuse at
    # the writer rather than write a line nothing can read back.
    return json.dumps({k: record[k] for k in RECORD_KEYS}, separators=(",", ":"), allow_nan=False)


def trim_lines(lines: list[str], max_lines: int) -> list[str]:
    """PURE. Keep the most recent `max_lines` entries.

    `max_lines <= 0` means UNBOUNDED and is honoured rather than silently coerced: an operator who
    sets 0 has asked for no cap, and a cap that ignores its own knob is worse than no cap.
    """
    if max_lines <= 0 or len(lines) <= max_lines:
        return lines
    return lines[-max_lines:]


def append_result(
    canary: str,
    verdict: str,
    exit_code: int,
    metrics: dict | None = None,
    *,
    path: str | None = None,
    max_lines: int | None = None,
    at: str | None = None,
) -> tuple[bool, str]:
    """Append one record. NEVER raises. Returns `(ok, detail)`.

    `detail` is `line=<n>` on success and a short reason on failure — the caller prints either
    one, so "wrote nothing" is never indistinguishable from "wrote a record".

    The append + trim run under an exclusive `flock`. Two canaries six minutes apart will never
    contend, but a lock is three lines and it removes the interleaved-write class outright rather
    than relying on the schedule staying spread out.
    """
    target = path or RESULTS_PATH
    cap = MAX_LINES if max_lines is None else max_lines
    try:
        line = build_record(canary, verdict, exit_code, metrics, at=at)
    except (TypeError, ValueError) as e:
        return False, f"unserialisable record ({type(e).__name__})"
    if len(line.encode("utf-8")) > MAX_LINE_BYTES:
        return False, f"record {len(line.encode('utf-8'))}B exceeds MAX_LINE_BYTES={MAX_LINE_BYTES}"

    try:
        directory = os.path.dirname(target) or "."
        os.makedirs(directory, exist_ok=True)
        # Opened "a+" so the file is created if absent and the descriptor is lockable either way.
        with open(target, "a+", encoding="utf-8") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            fh.write(line + "\n")
            fh.flush()
            os.fsync(fh.fileno())
            fh.seek(0)
            lines = fh.read().splitlines()
            kept = trim_lines(lines, cap)
            if len(kept) != len(lines):
                # Atomic replace, temp in the SAME directory so `os.replace` stays a rename.
                fd, tmp = tempfile.mkstemp(dir=directory, prefix=".canary-results.", suffix=".tmp")
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as tf:
                        tf.write("\n".join(kept) + "\n")
                        tf.flush()
                        os.fsync(tf.fileno())
                    os.chmod(tmp, 0o644)
                    os.replace(tmp, target)
                except BaseException:
                    if os.path.exists(tmp):
                        os.unlink(tmp)
                    raise
            return True, f"line={len(kept)}"
    except Exception as e:  # noqa: BLE001 — a recorder must never change its caller's outcome
        return False, f"{type(e).__name__}: {str(e)[:120]}"


ASSERTION_COUNT = 24


def self_test() -> int:
    """Hermetic — writes only under a temp directory, never `RESULTS_PATH`.

    Every assertion is wrapped so a broken subject reports FAIL rather than aborting: an assertion
    that RAISES is not an assertion, it is a crash, and a crash at a green exit code is how a
    guard goes dark.
    """
    failures: list[str] = []
    _ran: list[str] = []

    def check(name: str, fn) -> None:
        _ran.append(name)
        try:
            ok = fn()
        except Exception as e:  # noqa: BLE001
            failures.append(f"{name}: raised {type(e).__name__}: {e}")
            return
        if not ok:
            failures.append(name)

    # ── BYPASSED ARTIFACT #1: the record renderer ──
    rec = build_record("x-canary", "PASS", 0, {"a": 1}, at="2026-01-02T03:04:05Z", host="h")
    parsed = json.loads(rec)
    check("record is one line", lambda: "\n" not in rec)
    check("record carries the stamped instant", lambda: parsed["at"] == "2026-01-02T03:04:05Z")
    check("record carries the host label", lambda: parsed["host"] == "h")
    check("record carries the canary id", lambda: parsed["canary"] == "x-canary")
    check("record carries the verdict TOKEN, not the code alone", lambda: parsed["verdict"] == "PASS")
    check("record carries the exit code", lambda: parsed["exit_code"] == 0)
    check("record carries the metrics dict", lambda: parsed["metrics"] == {"a": 1})
    # KEY ORDER is contract, not cosmetics: the vault merge dedupes on byte-identical lines for a
    # re-run of the same instant, which only holds if the order is fixed.
    #
    # Asserted against an INDEPENDENT LITERAL, never against `RECORD_KEYS` itself. The vacuous
    # form (`tuple(parsed.keys()) == RECORD_KEYS`) was written first and MEASURED to survive a
    # deliberate reordering of that very constant — it asks whether the output matches whatever
    # the constant happens to be, which is true for every order it could take. Same defect the
    # parent wave found in its own weight assertion, in a new substrate.
    check("key order is the declared contract",
          lambda: tuple(parsed.keys()) == ("at", "host", "canary", "verdict", "exit_code", "metrics"))
    check("RECORD_KEYS still IS that contract",
          lambda: RECORD_KEYS == ("at", "host", "canary", "verdict", "exit_code", "metrics"))
    check("absent metrics renders as {}, never null",
          lambda: json.loads(build_record("c", "PASS", 0, None, at="t"))["metrics"] == {})
    check("a real clock is read when no instant is passed",
          lambda: build_record("c", "PASS", 0, {}).count("T") >= 1)

    def refuses_nan() -> bool:
        try:
            build_record("c", "PASS", 0, {"r": float("nan")}, at="t")
        except ValueError:
            return True
        return False
    check("REFUSES NaN rather than writing invalid JSON", refuses_nan)

    # ── BYPASSED ARTIFACT #2: the trimmer ──
    check("trim keeps the most RECENT lines", lambda: trim_lines(["1", "2", "3"], 2) == ["2", "3"])
    check("trim is a no-op under the cap", lambda: trim_lines(["1"], 5) == ["1"])
    check("trim at exactly the cap keeps everything", lambda: trim_lines(["1", "2"], 2) == ["1", "2"])
    check("max_lines <= 0 means UNBOUNDED, honoured not coerced",
          lambda: trim_lines(["1", "2", "3"], 0) == ["1", "2", "3"])

    # ── the IO layer, against a temp path ──
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "sub", "results.jsonl")
        ok1, d1 = append_result("c1", "PASS", 0, {"n": 1}, path=p, max_lines=3, at="2026-01-01T00:00:01Z")
        check("first append creates the file and its parent", lambda: ok1 and os.path.exists(p))
        check("first append reports its line count", lambda: d1 == "line=1")
        for i in range(2, 8):
            append_result("c1", "PASS", 0, {"n": i}, path=p, max_lines=3, at=f"2026-01-01T00:00:0{i}Z")
        body = open(p, encoding="utf-8").read().splitlines()
        check("the file is BOUNDED to max_lines", lambda: len(body) == 3)
        check("bounding keeps the newest records", lambda: json.loads(body[-1])["metrics"]["n"] == 7)
        check("every kept line is parseable JSON", lambda: all(json.loads(x) for x in body))
        check("no temp file is left behind",
              lambda: [f for f in os.listdir(os.path.dirname(p)) if f.startswith(".canary-results.")] == [])

        okB, dB = append_result("c1", "PASS", 0, {"blob": "x" * (MAX_LINE_BYTES + 10)}, path=p)
        check("an oversized record is REFUSED with a reason, not written",
              lambda: (not okB) and "MAX_LINE_BYTES" in dB)

    # ── PROVE IT REPORTS RATHER THAN RAISES: an unwritable path must return a reason ──
    def unwritable_is_reported() -> bool:
        ok, detail = append_result("c", "PASS", 0, {}, path="/proc/self/mem/nope/results.jsonl")
        return (not ok) and len(detail) > 0
    check("an unwritable path returns (False, reason) and never raises", unwritable_is_reported)

    if len(_ran) != ASSERTION_COUNT:
        failures.append(f"assertion count drifted: ran {len(_ran)}, ASSERTION_COUNT says {ASSERTION_COUNT}")

    if failures:
        print(f"SELF-TEST: FAIL ({len(failures)})")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"SELF-TEST: PASS ({ASSERTION_COUNT} assertions)")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if "--show-path" in argv:
        print(f"CANARY_RESULT_LOG_PATH={RESULTS_PATH} MAX_LINES={MAX_LINES} MAX_LINE_BYTES={MAX_LINE_BYTES}")
        return 0
    print(__doc__.strip().splitlines()[0])
    print("This module is imported by canaries; run --self-test or --show-path.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

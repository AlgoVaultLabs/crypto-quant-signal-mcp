#!/usr/bin/env python3
"""Hermetic suite for directional-label-freshness.py (no docker/psql/TG).

Runs the canary as a subprocess with LF_PSQL_CMD → a stub emitting canned
census rows, LF_WRAPPER → a capture script, tmp state/digest, frozen clock.
`python3 test-directional-label-freshness.py` → exit 0 all-pass.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CANARY = HERE / "directional-label-freshness.py"
NOW = 1_800_000_000
H = 3600

PASSED = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASSED
    if not cond:
        print(f"FAIL {name} {detail}")
        sys.exit(1)
    PASSED += 1
    print(f"ok   {name}")


def run(tmp: Path, rows: list[tuple[str, int, int | None]], *, state=None, argv=(), env_extra=None):
    stub = tmp / "psql_stub.sh"
    lines = "\n".join(f"{v}|{s}|{'' if l is None else l}" for v, s, l in rows)
    stub.write_text(f"#!/bin/bash\necho 'SET'\ncat <<'EOF'\n{lines}\nEOF\n")
    stub.chmod(0o755)
    wrapper = tmp / "wrapper.sh"
    wrapper.write_text('#!/bin/bash\nprintf "%s %s\\n" "$1" "$2" >> "$0.calls"\ncat >> "$0.body"\n')
    wrapper.chmod(0o755)
    state_file = tmp / "state.json"
    if state is not None:
        state_file.write_text(json.dumps(state))
    env = os.environ | {
        "LF_PSQL_CMD": str(stub),
        "LF_WRAPPER": str(wrapper),
        "LF_STATE_FILE": str(state_file),
        "LF_DIGEST_FILE": str(tmp / "digest.txt"),
        "LF_NOW_EPOCH": str(NOW),
    } | (env_extra or {})
    out = subprocess.run([sys.executable, str(CANARY), *argv], capture_output=True, text=True, env=env)
    calls = (tmp / "wrapper.sh.calls").read_text() if (tmp / "wrapper.sh.calls").exists() else ""
    body = (tmp / "wrapper.sh.body").read_text() if (tmp / "wrapper.sh.body").exists() else ""
    digest = (tmp / "digest.txt").read_text() if (tmp / "digest.txt").exists() else ""
    st = json.loads(state_file.read_text()) if state_file.exists() else {}
    return out, calls, body, digest, st


def fresh(hours: float) -> int:
    return NOW - int(hours * H)


with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # 1. healthy — majors + long-tail inside SLO → silent, digest written, exit 0
    out, calls, _, digest, st = run(tmp, [
        ("BINANCE", fresh(0.5), fresh(3)), ("OKX", fresh(0.5), fresh(10)),
        ("XT", fresh(1), fresh(30)),
    ])
    check("healthy: exit 0", out.returncode == 0, out.stderr)
    check("healthy: no page", calls == "")
    check("healthy: digest has all venues", "BINANCE" in digest and "XT" in digest)
    check("healthy: ok marks", digest.count(" ok") == 3, digest)

with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # 2. major breach day 1 → NO page (sustained gate), consecutive=1
    out, calls, _, digest, st = run(tmp, [("OKX", fresh(0.5), fresh(30))])
    check("day1: no page", calls == "")
    check("day1: consecutive=1", st["consecutive"].get("OKX") == 1, str(st))
    check("day1: BREACH in digest", "BREACH" in digest)
    # 3. day 2 (state carried) → pages once with contract body
    out, calls, body, _, st = run(tmp, [("OKX", fresh(0.5), fresh(30))],
                                  state={"consecutive": {"OKX": 1}})
    check("day2: pages", "DIRECTIONAL_LABEL_FRESHNESS_BREACH CRITICAL_PERSISTENT" in calls, calls)
    check("day2: body header", body.startswith("🛑 DIRECTIONAL_LABEL_FRESHNESS_BREACH"), body[:60])
    check("day2: body names venue+lag", "OKX lag=" in body)
    check("day2: recommended-wave template UNRESOLVED (wrapper resolves)", "OPS-LABEL-FRESHNESS-W{NEXT}" in body)
    check("day2: audit ref + source log", "endpoint-truth.md" in body and "Source log:" in body)

with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # 4. long-tail breach → digest-only, never pages, no consecutive tracking
    out, calls, _, digest, st = run(tmp, [("XT", fresh(0.5), fresh(100))],
                                    state={"consecutive": {"XT": 5}})
    check("longtail: no page ever", calls == "")
    check("longtail: BREACH marked in digest", "BREACH" in digest)
    check("longtail: majors-consecutive cleared for non-breaching", st["consecutive"] == {}, str(st))

with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # 5. input NOT flowing (idle venue) → skipped even with ancient labels
    out, calls, _, digest, _ = run(tmp, [("BINANCE", fresh(60), fresh(500))])
    check("idle: no page", calls == "")
    check("idle: marked idle not BREACH", "idle" in digest and "BREACH" not in digest, digest)

with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # 6. never-labeled long-tail (PHEMEX class) → lag=never, digest-only
    out, calls, _, digest, _ = run(tmp, [("PHEMEX", fresh(0.5), None)])
    check("never-labeled: digest lag=never", "never" in digest)
    check("never-labeled: no page (long-tail)", calls == "")

with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # 7. breach heals → consecutive resets to 0
    out, calls, _, _, st = run(tmp, [("OKX", fresh(0.5), fresh(3))],
                               state={"consecutive": {"OKX": 1}})
    check("heal: venue dropped from state", "OKX" not in st["consecutive"], str(st))
    check("heal: no page", calls == "")

with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # 8. --force-stale without DRY_RUN_TG=1 → refused (runbook §6)
    out, calls, _, _, _ = run(tmp, [("BINANCE", fresh(0.5), fresh(3))], argv=("--force-stale", "BINANCE"))
    check("force-stale unguarded: refused", "REFUSING" in out.stdout and calls == "", out.stdout)
    # 9. --force-stale WITH DRY_RUN_TG=1, pre-seeded consecutive → wrapper called
    #    (the wrapper's own DRY_RUN gate suppresses the real POST)
    out, calls, body, _, _ = run(tmp, [("BINANCE", fresh(0.5), fresh(3))],
                                 argv=("--force-stale", "BINANCE"),
                                 state={"consecutive": {"BINANCE": 1}},
                                 env_extra={"DRY_RUN_TG": "1"})
    check("force-stale smoke: wrapper exercised", "DIRECTIONAL_LABEL_FRESHNESS_BREACH" in calls, calls)
    check("force-stale smoke: synthetic lag in body", "999.0h" in body, body)

with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # 10. psql failure → fail-open exit 0, no page, no state write
    stub = tmp / "psql_stub.sh"; stub.write_text("#!/bin/bash\nexit 3\n"); stub.chmod(0o755)
    env = os.environ | {"LF_PSQL_CMD": str(stub), "LF_WRAPPER": str(tmp / "nope.sh"),
                        "LF_STATE_FILE": str(tmp / "s.json"), "LF_DIGEST_FILE": str(tmp / "d.txt"),
                        "LF_NOW_EPOCH": str(NOW)}
    out = subprocess.run([sys.executable, str(CANARY)], capture_output=True, text=True, env=env)
    check("fail-open: exit 0 on psql error", out.returncode == 0 and "FAIL_OPEN" in out.stdout, out.stdout)
    check("fail-open: no state written", not (tmp / "s.json").exists())

print(f"\nALL {PASSED} ASSERTIONS PASSED")

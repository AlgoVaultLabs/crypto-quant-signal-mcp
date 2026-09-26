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
FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    # GENERATOR FIX (OPS-LABEL-FRESHNESS-SELFTEST-TRUNCATION-W1): collect-and-continue.
    # The prior `sys.exit(1)` on the FIRST failing assertion truncated the whole suite — a
    # single red assertion left every later assertion UNEXECUTED, so the host self-test
    # reported on a fraction of its checks and its tail was permanently dark. A self-test
    # that aborts on first failure cannot answer "what else is broken?". Record every
    # failure, keep going, and exit non-zero exactly once at the END with the full tally.
    global PASSED
    if not cond:
        FAILURES.append(f"{name} {detail}".rstrip())
        print(f"FAIL {name} {detail}")
        return
    PASSED += 1
    print(f"ok   {name}")


def run(tmp: Path, rows: list[tuple[str, int, int | None]], *, state=None, argv=(), env_extra=None, retired=(), coverage=None):
    stub = tmp / "psql_stub.sh"
    lines = "\n".join(f"{v}|{s}|{'' if l is None else l}" for v, s, l in rows)
    stub.write_text(f"#!/bin/bash\necho 'SET'\ncat <<'EOF'\n{lines}\nEOF\n")
    stub.chmod(0o755)
    # OPS-VENUE-STATUS-DERIVED-REGISTRIES-W1 (Q3): a SEPARATE stub for the retired-venue set
    # (LF_RETIRED_CMD). Default empty → existing cases see no retired venues (behaviour unchanged).
    retired_stub = tmp / "retired_stub.sh"
    rlines = "\n".join(retired)
    retired_stub.write_text(f"#!/bin/bash\necho 'SET'\ncat <<'EOF'\n{rlines}\nEOF\n")
    retired_stub.chmod(0o755)
    wrapper = tmp / "wrapper.sh"
    wrapper.write_text('#!/bin/bash\nprintf "%s %s\\n" "$1" "$2" >> "$0.calls"\ncat >> "$0.body"\n')
    wrapper.chmod(0o755)
    state_file = tmp / "state.json"
    if state is not None:
        state_file.write_text(json.dumps(state))
        # OPS-LABEL-FRESHNESS-SELFTEST-TRUNCATION-W1 (option a): SEC-30 in
        # directional-label-freshness.py redirects BOTH state and digest to a
        # `<file>.forced-smoke` sibling whenever --force-stale is set — precisely so a
        # synthetic breach can never touch production state — and it does so BEFORE the
        # consecutive-state read. So on the forced path the base state.json is never read;
        # to exercise the day-2 SUSTAINED-DRIFT page under --force-stale the pre-seeded
        # day-1 state must land where the redirected read looks. Mirror the seed there using
        # the SAME suffix transform SEC-30 applies. This does NOT weaken SEC-30's isolation:
        # production state stays the base file, and every synthetic write the canary makes
        # still lands only on the .forced-smoke sibling.
        if "--force-stale" in argv:
            forced_state = state_file.with_suffix(state_file.suffix + ".forced-smoke")
            forced_state.write_text(json.dumps(state))
    env = os.environ | {
        "LF_PSQL_CMD": str(stub),
        "LF_WRAPPER": str(wrapper),
        "LF_STATE_FILE": str(state_file),
        "LF_DIGEST_FILE": str(tmp / "digest.txt"),
        "LF_NOW_EPOCH": str(NOW),
        "LF_RECOVERY_ENABLED": "0",  # hermetic by default; recovery cases opt in via env_extra
        "LF_RETIRED_CMD": str(retired_stub),
    } | (env_extra or {})
    # OPS-BDIR-V3-PANEL-READINESS-W1 CH2 R3: a SEPARATE stub for the coverage arm (LF_COVERAGE_CMD).
    # Absent → the arm reads nothing and reports INDETERMINATE (existing cases are unaffected).
    if coverage is not None:
        cov_stub = tmp / "coverage_stub.sh"
        clines = "\n".join(f"{v}|{e}|{l}" for v, e, l in coverage)
        cov_stub.write_text(f"#!/bin/bash\necho 'SET'\ncat <<'EOF'\n{clines}\nEOF\n")
        cov_stub.chmod(0o755)
        env["LF_COVERAGE_CMD"] = str(cov_stub)
    else:
        env["LF_COVERAGE_CMD"] = "false"  # a command that fails → the arm is INDETERMINATE, never PASS
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

with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # 11. R2 single-derivation — the canary reads the tier set from the SoT mirror (LF_TIERS_FILE),
    #     not a hardcoded set. A custom mirror renames the majors; classification must follow it.
    tiers = tmp / "tiers.json"
    tiers.write_text(json.dumps({"majors": ["ZED"], "major_slo_hours": 24,
                                 "longtail_slo_hours": 72, "barrier_spec": "tau1.0-floor0.30-v1"}))
    out, calls, _, digest, _ = run(tmp, [("ZED", fresh(0.5), fresh(30)), ("BINANCE", fresh(0.5), fresh(30))],
                                   env_extra={"LF_TIERS_FILE": str(tiers)})
    zed_line = next(l for l in digest.splitlines() if l.startswith("ZED"))
    bnb_line = next(l for l in digest.splitlines() if l.startswith("BINANCE"))
    check("tiers: custom major ZED → major + BREACH (read from mirror)", "major" in zed_line and "BREACH" in zed_line, zed_line)
    check("tiers: BINANCE follows mirror → long-tail + ok (NOT hardcoded)", "long-tail" in bnb_line and bnb_line.rstrip().endswith("ok"), bnb_line)
    check("tiers: no page day1", calls == "")

with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # 12. R3 recovery DRY_RUN (autopilot first-fire gate) — a breaching major logs the intended
    #     targeted re-label WITHOUT running it, and (dry-run heals nothing) still pages at day 2.
    out, calls, _, _, _ = run(tmp, [("OKX", fresh(0.5), fresh(30))],
                              state={"consecutive": {"OKX": 1}},
                              env_extra={"LF_RECOVERY_ENABLED": "1", "LF_RECOVERY_DRY_RUN": "1"})
    check("recovery: DRY_RUN logs the intended re-label", "RECOVERY_DRY_RUN would run" in out.stdout and "--venue OKX" in out.stdout, out.stdout)
    check("recovery: dry-run heals nothing → still pages", "DIRECTIONAL_LABEL_FRESHNESS_BREACH" in calls, calls)

with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # 13. R3 recovery HEALS → silent (Detect→Recover→Verify→no page). Stateful psql stub returns
    #     OKX breaching on the 1st census, healthy on the re-census; the recovery cmd (seam) exits 0.
    stub = tmp / "psql_stub.sh"
    stub.write_text(
        "#!/bin/bash\n"
        f'CNT="{tmp}/cnt"; n=$(cat "$CNT" 2>/dev/null || echo 0); echo $((n+1)) > "$CNT"\n'
        "echo 'SET'\n"
        f'if [ "$n" -eq 0 ]; then echo "OKX|{fresh(0.5)}|{fresh(30)}"; else echo "OKX|{fresh(0.5)}|{fresh(3)}"; fi\n'
    )
    stub.chmod(0o755)
    rec = tmp / "rec.sh"
    rec.write_text('#!/bin/bash\necho "recovered $1" >> "$0.log"\nexit 0\n')
    rec.chmod(0o755)
    wrapper = tmp / "wrapper.sh"
    wrapper.write_text('#!/bin/bash\nprintf "%s %s\\n" "$1" "$2" >> "$0.calls"\ncat >> "$0.body"\n')
    wrapper.chmod(0o755)
    state_file = tmp / "state.json"
    state_file.write_text(json.dumps({"consecutive": {"OKX": 1}}))
    env = os.environ | {
        "LF_PSQL_CMD": str(stub), "LF_WRAPPER": str(wrapper), "LF_STATE_FILE": str(state_file),
        "LF_DIGEST_FILE": str(tmp / "digest.txt"), "LF_NOW_EPOCH": str(NOW),
        "LF_RECOVERY_ENABLED": "1", "LF_RECOVERY_CMD": str(rec),
        "LF_RETIRED_CMD": "true",  # hermetic: no docker; retired_set() → empty
    }
    out = subprocess.run([sys.executable, str(CANARY)], capture_output=True, text=True, env=env)
    calls = (tmp / "wrapper.sh.calls").read_text() if (tmp / "wrapper.sh.calls").exists() else ""
    check("recovery-heal: targeted re-label invoked", (tmp / "rec.sh.log").exists() and "recovered OKX" in (tmp / "rec.sh.log").read_text())
    check("recovery-heal: re-census shows healed", "RECOVERY_HEALED" in out.stdout and "OKX" in out.stdout, out.stdout)
    check("recovery-heal: SILENT — no page after heal", calls == "", calls)

with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # OPS-VENUE-STATUS-DERIVED-REGISTRIES-W1 (Q3): a RETIRED venue with recent signals + lagging labels
    # (exactly the stranded-backlog shape a retirement leaves) renders `retired`, NEVER BREACH, never pages.
    fixture = [("BITMART", fresh(1), fresh(200))]  # input_flowing (1h) + lag 200h > 72h long-tail SLO
    out, calls, _, digest, _ = run(tmp, fixture, retired=["BITMART"])
    check("retired: exit 0", out.returncode == 0, out.stderr)
    check("retired: rendered `retired`, not BREACH", "retired" in digest and "BREACH" not in digest, digest)
    check("retired: no page", calls == "")
    # CONTROL (proves the assertion can fail): the SAME fixture WITHOUT the retired flag DOES breach.
    out2, calls2, _, digest2, _ = run(tmp, fixture, retired=[])
    check("retired-control: same fixture breaches when NOT retired", "BREACH" in digest2, digest2)
    check("retired-control: still never pages (long-tail)", calls2 == "")

# ── OPS-BDIR-V3-PANEL-READINESS-W1 CH2 R3 — the per-venue COVERAGE arm ─────────────────────────
# labelled / emitted (primary spec) over the trailing 7 days on rows whose label window has closed.
# PAGES only for the FULL-eligible venues (tier mirror `full_panel_venues`); every other venue REPORTS
# with its declared reason (architect ruling Q-F, 2026-09-26).
HEALTHY_FULL = [("BINANCE", 1000, 995), ("BYBIT", 800, 796), ("OKX", 700, 680), ("BITGET", 1200, 1100), ("KUCOIN", 1000, 950)]
KUCOIN_69 = [v for v in HEALTHY_FULL if v[0] != "KUCOIN"] + [("KUCOIN", 1000, 690)]
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    healthy_census = [("BINANCE", fresh(0.5), fresh(3))]
    # C1 — DAY 1: a FULL-eligible venue below 90% is FAIL (token) but the page is HELD — the canary's
    # own sustained-drift idiom (CONSECUTIVE_TO_PAGE); the nightly labeler IS the recovery, and a page
    # for a gap the next nightly may close is recovery chatter. The run is remembered in state.
    out, calls, body, _, st = run(tmp, healthy_census, coverage=KUCOIN_69)
    check("coverage: token FAIL on day 1", "DIRECTIONAL_LABEL_COVERAGE_VERDICT=FAIL" in out.stdout, out.stdout[-400:])
    check("coverage: day 1 does NOT page", "COVERAGE_SHORTFALL" not in calls, calls)
    check("coverage: day 1 logs the HOLD naming the venue", "COVERAGE_HOLD KUCOIN" in out.stdout, out.stdout[-600:])
    check("coverage: day 1 is remembered (ratio + consecutive fails)",
          st.get("coverage", {}).get("KUCOIN") == {"ratio": 0.69, "fails": 1}, json.dumps(st))
    check("coverage: positive per-venue line for every FULL venue",
          all(f"COVERAGE {v}" in out.stdout for v, _, _ in HEALTHY_FULL), out.stdout[-600:])
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # C7 — DAY 2, STALLED: still below 90% and no real gain since the previous run → PAGE
    out, calls, body, _, st = run(tmp, [("BINANCE", fresh(0.5), fresh(3))], coverage=KUCOIN_69,
                                  state={"coverage": {"KUCOIN": {"ratio": 0.69, "fails": 1}}})
    check("coverage: day-2 stalled FULL venue pages", "DIRECTIONAL_LABEL_COVERAGE_SHORTFALL CRITICAL_PERSISTENT" in calls, calls)
    check("coverage: body names the venue with its noun + ratio", "venue KUCOIN" in body and "69.0%" in body, body)
    check("coverage: body carries the streak and the previous run", "2 consecutive" in body and "69.0%" in body, body)
    check("coverage: streak advances to 2", st.get("coverage", {}).get("KUCOIN", {}).get("fails") == 2, json.dumps(st))
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # C8 — DAY 2, RECOVERING: below 90% but gained >= 2 pp since the previous run → HOLD (the nightly
    # is closing the gap)
    out, calls, _, _, st = run(tmp, [("BINANCE", fresh(0.5), fresh(3))], coverage=KUCOIN_69,
                               state={"coverage": {"KUCOIN": {"ratio": 0.40, "fails": 1}}})
    check("coverage: a recovering FULL venue does not page", "COVERAGE_SHORTFALL" not in calls, calls)
    check("coverage: the hold says recovering, with the gain", "COVERAGE_HOLD KUCOIN" in out.stdout and "recovering" in out.stdout
          and "+29.0 pp" in out.stdout, out.stdout[-600:])
    check("coverage: token is still FAIL while recovering", "DIRECTIONAL_LABEL_COVERAGE_VERDICT=FAIL" in out.stdout, out.stdout[-300:])
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # C9 — the gain boundary: +2.0 pp holds, +1.9 pp pages
    out_at, calls_at, _, _, _ = run(tmp, [("BINANCE", fresh(0.5), fresh(3))], coverage=KUCOIN_69,
                                    state={"coverage": {"KUCOIN": {"ratio": 0.67, "fails": 1}}})
    check("coverage: +2.0 pp is recovering (held)", "COVERAGE_SHORTFALL" not in calls_at, calls_at)
    (tmp / "wrapper.sh.calls").unlink(missing_ok=True)
    out_below, calls_below, _, _, _ = run(tmp, [("BINANCE", fresh(0.5), fresh(3))], coverage=KUCOIN_69,
                                          state={"coverage": {"KUCOIN": {"ratio": 0.671, "fails": 1}}})
    check("coverage: +1.9 pp is not recovering (pages)", "DIRECTIONAL_LABEL_COVERAGE_SHORTFALL CRITICAL_PERSISTENT" in calls_below, calls_below)
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # C10 — the 7-day window has fully turned over: still below 90% after COVERAGE_WINDOW_D consecutive
    # runs pages EVEN IF gaining — "recovering" no longer explains a whole window of shortfall
    out, calls, _, _, st = run(tmp, [("BINANCE", fresh(0.5), fresh(3))], coverage=KUCOIN_69,
                               state={"coverage": {"KUCOIN": {"ratio": 0.60, "fails": 7}}})
    check("coverage: FAIL past the window turnover pages despite a gain",
          "DIRECTIONAL_LABEL_COVERAGE_SHORTFALL CRITICAL_PERSISTENT" in calls, calls)
    check("coverage: streak advances to 8", st.get("coverage", {}).get("KUCOIN", {}).get("fails") == 8, json.dumps(st))
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # C11 — PASS forgets the streak (a later FAIL is day 1 again) and clears the alert
    out, calls, _, _, st = run(tmp, [("BINANCE", fresh(0.5), fresh(3))], coverage=HEALTHY_FULL,
                               state={"coverage": {"KUCOIN": {"ratio": 0.69, "fails": 3}}})
    check("coverage: PASS drops the venue from coverage state", st.get("coverage") == {}, json.dumps(st))
    check("coverage: PASS clears", "--clear DIRECTIONAL_LABEL_COVERAGE_SHORTFALL" in calls, calls)
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # C12 — an unreadable coverage census keeps the streak exactly as it was (no reset, no advance)
    seeded = {"KUCOIN": {"ratio": 0.5, "fails": 2}}
    out, calls, _, _, st = run(tmp, [("BINANCE", fresh(0.5), fresh(3))], state={"coverage": seeded})
    check("coverage: INDETERMINATE keeps the streak unchanged", st.get("coverage") == seeded, json.dumps(st))
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # C13 — non-FULL venues are never tracked (they never page); C14 — the frontier arm's own state is
    # written alongside, not clobbered by the coverage write
    out, calls, _, _, st = run(tmp, [("BYBIT", fresh(0.5), fresh(30))], coverage=HEALTHY_FULL + [("GATE", 5000, 2020)],
                               state={"consecutive": {"BYBIT": 1}})
    check("coverage: a non-FULL shortfall is never tracked", "GATE" not in st.get("coverage", {"GATE": 1}), json.dumps(st))
    check("coverage state does not clobber the frontier streak", st.get("consecutive", {}).get("BYBIT") == 2, json.dumps(st))
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # C2 — non-FULL venues below 90% REPORT with their declared reason and never page; FULL all healthy → PASS
    cov = HEALTHY_FULL + [("GATE", 5000, 2020), ("HL", 2000, 780)]
    out, calls, body, _, _ = run(tmp, [("BINANCE", fresh(0.5), fresh(3))], coverage=cov)
    check("coverage: non-FULL shortfall never pages", "CRITICAL_PERSISTENT" not in calls, calls)
    check("coverage: GATE reported, not paged", "COVERAGE GATE" in out.stdout and "arm=REPORT" in out.stdout, out.stdout[-800:])
    check("coverage: HL's declared reason names rule (d) and the candle horizon",
          "rule (d)" in out.stdout and "horizon" in out.stdout, out.stdout[-800:])
    check("coverage: token PASS when every FULL venue >= 90%", "DIRECTIONAL_LABEL_COVERAGE_VERDICT=PASS" in out.stdout, out.stdout[-400:])
    check("coverage: PASS clears the coverage alert state", "--clear DIRECTIONAL_LABEL_COVERAGE_SHORTFALL" in calls, calls)
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # C3 — a FULL venue MISSING from the coverage result is INDETERMINATE, never PASS; nothing pages
    cov = [v for v in HEALTHY_FULL if v[0] != "BYBIT"]
    out, calls, _, _, _ = run(tmp, [("BINANCE", fresh(0.5), fresh(3))], coverage=cov)
    check("coverage: a missing FULL venue is INDETERMINATE", "DIRECTIONAL_LABEL_COVERAGE_VERDICT=INDETERMINATE" in out.stdout, out.stdout[-400:])
    check("coverage: INDETERMINATE never pages", "COVERAGE_SHORTFALL CRITICAL" not in calls, calls)
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # C4 — the boundary: exactly 90.0% passes, 89.9% fails
    at = [v for v in HEALTHY_FULL if v[0] != "OKX"] + [("OKX", 1000, 900)]
    below = [v for v in HEALTHY_FULL if v[0] != "OKX"] + [("OKX", 1000, 899)]
    out_at, _, _, _, _ = run(tmp, [("BINANCE", fresh(0.5), fresh(3))], coverage=at)
    out_below, _, _, _, _ = run(tmp, [("BINANCE", fresh(0.5), fresh(3))], coverage=below)
    check("coverage: exactly 90.0% passes", "DIRECTIONAL_LABEL_COVERAGE_VERDICT=PASS" in out_at.stdout, out_at.stdout[-300:])
    check("coverage: 89.9% fails", "DIRECTIONAL_LABEL_COVERAGE_VERDICT=FAIL" in out_below.stdout, out_below.stdout[-300:])
with tempfile.TemporaryDirectory() as d:
    tmp = Path(d)
    # C5 — an unreadable coverage query is INDETERMINATE (the census path still runs; exit stays 0)
    out, calls, _, digest, _ = run(tmp, [("BINANCE", fresh(0.5), fresh(3))])
    check("coverage: unreadable input is INDETERMINATE", "DIRECTIONAL_LABEL_COVERAGE_VERDICT=INDETERMINATE" in out.stdout, out.stdout[-300:])
    check("coverage: the freshness digest is unaffected", "BINANCE" in digest, digest)
    check("coverage: exit still 0 (fail-open canary)", out.returncode == 0, out.stderr)

# C6 — THE BYPASSED ARTIFACT: the coverage SQL is asserted by SHAPE (a hermetic run never executes it)
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location("dlf", CANARY)
_m = _ilu.module_from_spec(_spec); _spec.loader.exec_module(_m)
# getattr, not attribute access: a missing builder must report FAIL on every shape check below,
# not abort the suite (an assertion that RAISES is not an assertion)
_sql = getattr(_m, "coverage_sql", lambda _n: "")(NOW)
_EVAL_W = getattr(_m, "EVAL_W", {"__missing__": 0})
check("coverage SQL: primary spec only", "d.barrier_spec = 'tau1.0-floor0.30-v1'" in _sql, _sql)
check("coverage SQL: emitted = BUY/SELL (rule (c)'s denominator)", "s.signal IN ('BUY','SELL')" in _sql, _sql)
check("coverage SQL: 7-day window", f"s.created_at >= {NOW - 7 * 86400}" in _sql, _sql)
check("coverage SQL: only rows whose label window has closed (+ grace)", "s.created_at + w.window_s + 86400 <= " in _sql, _sql)
check("coverage SQL: retired venues excluded", "status = 'retired'" in _sql, _sql)
check("coverage SQL: no % token", "%" not in _sql, _sql)
check("coverage SQL: every labelled timeframe carries its window", all(f"('{tf}', " in _sql for tf in _EVAL_W), _sql)

TOTAL = PASSED + len(FAILURES)
if FAILURES:
    print(f"\n{PASSED} of {TOTAL} ASSERTIONS PASSED — {len(FAILURES)} FAILED:")
    for f in FAILURES:
        print(f"  FAIL {f}")
    sys.exit(1)
print(f"\nALL {PASSED} ASSERTIONS PASSED")

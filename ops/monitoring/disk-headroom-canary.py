#!/usr/bin/env python3
"""disk-headroom-canary.py — OPS-SCORER-INPUT-PERSISTENCE-W1 R4 (Q4-ii).

Detect and alert on filesystem headroom. DETECT AND ALERT ONLY — it prunes nothing, deletes
nothing, and runs no reclaim command. Attribution and reclaim already have owners:
`ops/scripts/disk-forensics.sh` is the read-only per-source attribution tool (and names itself
the seed for a future `disk-fill` autopilot), and reclaim is a separate Plan-Mode-gated wave.
This file is the missing piece between them: the thing that NOTICES.

── WHY IT EXISTS, STATED HONESTLY ───────────────────────────────────────────────────────────

OPS-SCORER-INPUT-PERSISTENCE-W1 committed to unbounded retention of the scorer-input corpus (no
sampling, no TTL) on the argument that attribution power grows with elapsed time and a cap would
guarantee never holding a full market cycle. An open-ended commitment is not a control, so it
ships with this alarm.

But the arithmetic says plainly that this wave is NOT the binding growth term, and pretending
otherwise would be the kind of self-flattering framing that makes an alarm ignorable. MEASURED on
signal-1, 2026-08-31:

    filesystem /dev/sda1 : 301 G total, 51 G used (18%), 238 G available
    scorer-input capture : ~6.95 MB/day  (hold 6.57 + band 0.22 + emitted 1.17, minus rounding)
    headroom to the 85% threshold : 204.85 G
    months-to-threshold FROM THIS WAVE ALONE : ~991 months (~82.6 years)

So this is a GENERAL disk guard that the scorer wave happens to have paid for, not a
scorer-specific one. It is scoped to the whole filesystem for exactly that reason: an alarm
watching only this wave's tables would stay quiet while the box filled up from anywhere else.

VERDICT TOKEN — callers gate on the TOKEN, never the bare exit code:

    DISK_HEADROOM_VERDICT=PASS | FAIL | INDETERMINATE

    exit 0 = PASS           every watched filesystem is below its warn threshold
    exit 1 = FAIL           at least one is at or above a threshold (severity says which)
    exit 3 = INDETERMINATE  could not read `df` / unparseable output

3 for INDETERMINATE: the token-law default for a NEW gate.

SEVERITY, printed as its own line so the alert wrapper can gate on it:

    DISK_HEADROOM_SEVERITY=none | warning | critical

    warning  >= 85% used   — months of runway left; a reclaim wave is worth scheduling
    critical >= 92% used   — Postgres needs free space for WAL, vacuum and temp files, so the
                             database degrades well before 100%; 92% is the last point at which
                             a reclaim is comfortable rather than an incident

COOLDOWN is INHERITED, not reimplemented: `send_telegram.sh` already applies a 24h per-alert-id
cooldown, and a second cooldown here would be a second definition of "how often may this page"
that drifts from the first. This file is stateless by construction.

    disk-headroom-canary.py              # live check
    disk-headroom-canary.py --self-test  # hermetic; no filesystem read
"""
from __future__ import annotations

import os
import subprocess
import sys

# Thresholds as PERCENT USED. Overridable so a differently-sized host can carry its own numbers
# without a code change; defaults are the ones derived above.
WARN_PCT = int(os.environ.get("DH_WARN_PCT", "85"))
CRIT_PCT = int(os.environ.get("DH_CRIT_PCT", "92"))

# Filesystems to watch. `/` covers the docker volume root on this host (`/var/lib/docker` is on
# the same device — measured, both report /dev/sda1), so one mount point is the whole story here.
MOUNTS = tuple(m for m in os.environ.get("DH_MOUNTS", "/").split(",") if m.strip())

# The growth rate this wave added, in MB/day, carried so the alert can state runway rather than
# just a percentage. A percentage tells an operator they have a problem; a runway tells them
# whether it is this week's problem.
SCORER_MB_PER_DAY = float(os.environ.get("DH_SCORER_MB_PER_DAY", "6.95"))

EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
_RANK = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 2}

# ── ALERT DISPATCH ───────────────────────────────────────────────────────────────────────────
#
# The canary fires the wrapper itself; a canary that only prints a token is INSTALLED but DARK.
# send_telegram.sh owns the 24h per-alert-id cooldown, the severity gate and the dry-run lever.
TG = os.environ.get("DH_TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
ALERT_ID = "disk_headroom"

# `CRITICAL_PERSISTENT` is the ONLY severity send_telegram.sh actually delivers — by its own
# contract every other value logs silently. So BOTH ladder tiers deliver, and the tier is carried
# in the BODY rather than in a severity string the wrapper would drop.
#
# That is a deliberate choice, not an accident of the wrapper, and the ladder is not decorative
# because of it: at >=85% the action is "schedule a reclaim wave", at >=92% it is "reclaim now,
# Postgres is about to lose its WAL/vacuum/temp headroom". Both are operator-action-required, and
# an alarm that stayed silent until 92% would remove the only tier at which the fix is unhurried.
SEVERITY_DELIVERED = "CRITICAL_PERSISTENT"


def fire(body: str) -> None:
    """Dispatch to the shared wrapper. Stubbable, and fail-open — a broken wrapper must never turn
    a reporting run into a crash."""
    try:
        subprocess.run([TG, ALERT_ID, SEVERITY_DELIVERED, "-"],
                       input=body, text=True, timeout=30, check=False)
    except Exception as e:  # noqa: BLE001
        print(f"[disk-headroom] TG dispatch failed (fail-open): {e}", file=sys.stderr)


def clear() -> None:
    """FIRING -> CLEAR on the healthy path. State hygiene: send_telegram.sh writes its cooldown
    marker on a delivered fire and nothing else removes it, so without this a reclaimed disk would
    leave the channel's last word at the worst it ever got."""
    try:
        subprocess.run([TG, "--clear", ALERT_ID, "every watched filesystem below the warn threshold"],
                       timeout=30, check=False, capture_output=True)
    except Exception as e:  # noqa: BLE001
        print(f"[disk-headroom] TG clear failed (fail-open): {e}", file=sys.stderr)


def parse_df(out: str) -> list[dict[str, object]]:
    """Parse `df -P -k` output into rows.

    `-P` is load-bearing: without it a long device name WRAPS onto a second line and the fields
    shift, which would read as a parse error at best and a wrong number at worst. `-k` fixes the
    unit at 1K blocks so no locale or `-h` suffix has to be interpreted.

    Pure, and self-tested — a hermetic self-test is blind to exactly what its seam replaces, and
    for this file the `df` call is that seam, so the parser is the artifact that must be asserted
    directly.
    """
    rows: list[dict[str, object]] = []
    lines = [l for l in out.strip().splitlines() if l.strip()]
    if len(lines) < 2:
        raise ValueError(f"df produced no data rows: {out.strip()[:120]!r}")
    for line in lines[1:]:  # skip the header
        f = line.split()
        if len(f) < 6:
            raise ValueError(f"expected >=6 df fields, got {len(f)}: {line[:120]!r}")
        # -P guarantees: Filesystem 1024-blocks Used Available Capacity Mounted-on
        rows.append({
            "device": f[0],
            "total_kb": int(f[1]),
            "used_kb": int(f[2]),
            "avail_kb": int(f[3]),
            "pct_used": int(f[4].rstrip("%")),
            "mount": f[5],
        })
    return rows


def severity_for(pct: int) -> str:
    if pct >= CRIT_PCT:
        return "critical"
    if pct >= WARN_PCT:
        return "warning"
    return "none"


def months_to(pct_target: int, row: dict[str, object], mb_per_day: float) -> float:
    """Months until `pct_used` reaches `pct_target` at a given growth rate.

    Returns `inf` for a non-positive rate rather than dividing by zero — a rate of zero means
    "not growing", whose honest runway is unbounded, and an exception here would take out a check
    that is otherwise fine.
    """
    if mb_per_day <= 0:
        return float("inf")
    total_kb = int(row["total_kb"])
    used_kb = int(row["used_kb"])
    headroom_kb = total_kb * pct_target / 100.0 - used_kb
    if headroom_kb <= 0:
        return 0.0
    return (headroom_kb / (mb_per_day * 1024)) / 30.44


def worst(verdicts: list[str]) -> str:
    """Worst-of. An EMPTY list is INDETERMINATE — no filesystem was evaluated, which is the
    vacuity case: a run that checked nothing must never report that everything is fine."""
    if not verdicts:
        return "INDETERMINATE"
    return max(verdicts, key=lambda v: _RANK[v])


def check() -> tuple[str, str, list[str]]:
    try:
        out = subprocess.run(
            ["df", "-P", "-k", *MOUNTS], capture_output=True, text=True, timeout=30,
        )
        if out.returncode != 0:
            raise RuntimeError(f"df rc={out.returncode}: {out.stderr.strip()[:160]}")
        rows = parse_df(out.stdout)
    except Exception as e:  # noqa: BLE001 — a failure to READ is INDETERMINATE, never a pass
        # An unreadable `df` is an INSTRUMENT fault, not a disk fault. It does NOT page: the
        # monitoring inventory's DARK check already covers a canary that stops producing, and
        # paging on the instrument trains the operator to ignore the channel.
        print(f"  INDETERMINATE — {type(e).__name__}: {str(e)[:160]}")
        return "INDETERMINATE", "none", []

    verdicts: list[str] = []
    severities: list[str] = []
    breaches: list[str] = []
    for r in rows:
        pct = int(r["pct_used"])
        sev = severity_for(pct)
        runway = months_to(WARN_PCT, r, SCORER_MB_PER_DAY)
        # POSITIVE PER-ROW OUTPUT, always: a filesystem silently skipped must not look like one
        # that passed.
        print(
            f"  {r['mount']:12s} {pct:3d}% used  "
            f"({int(r['used_kb'])//1048576}G of {int(r['total_kb'])//1048576}G, "
            f"{int(r['avail_kb'])//1048576}G free)  warn>={WARN_PCT}% crit>={CRIT_PCT}%  "
            f"severity={sev}  "
            f"scorer-capture runway to warn: "
            f"{'unbounded' if runway == float('inf') else f'{runway:.0f} months'} "
            f"@ {SCORER_MB_PER_DAY} MB/day"
        )
        verdicts.append("FAIL" if sev != "none" else "PASS")
        severities.append(sev)
        if sev != "none":
            breaches.append(
                f"  {r['mount']} at {pct}% used ({int(r['avail_kb'])//1048576}G free of "
                f"{int(r['total_kb'])//1048576}G) — {sev} (warn>={WARN_PCT}%, crit>={CRIT_PCT}%)")

    sev = "critical" if "critical" in severities else ("warning" if "warning" in severities else "none")
    return worst(verdicts), sev, breaches


def self_test() -> int:
    failures: list[str] = []
    _ran: list[str] = []

    def chk(name: str, fn) -> None:
        _ran.append(name)
        try:
            ok = fn()
        except Exception as e:  # noqa: BLE001 — an assertion that RAISES is not an assertion
            failures.append(f"{name}: raised {type(e).__name__}: {e}")
            return
        if not ok:
            failures.append(name)

    SAMPLE = (
        "Filesystem     1024-blocks      Used Available Capacity Mounted on\n"
        "/dev/sda1        315621376  53477376 246030848      18% /\n"
    )
    rows = parse_df(SAMPLE)

    # ── the BYPASSED artifact: the df parser ──
    chk("parses one row", lambda: len(rows) == 1)
    chk("reads the mount point", lambda: rows[0]["mount"] == "/")
    chk("reads percent used", lambda: rows[0]["pct_used"] == 18)
    chk("reads used and total", lambda: rows[0]["used_kb"] == 53477376 and rows[0]["total_kb"] == 315621376)

    def rejects_header_only() -> bool:
        try:
            parse_df("Filesystem 1024-blocks Used Available Capacity Mounted on\n")
        except ValueError:
            return True
        return False
    chk("REJECTS a header-only df rather than reporting zero filesystems", rejects_header_only)

    def rejects_short_row() -> bool:
        try:
            parse_df("Filesystem 1024-blocks Used\n/dev/sda1 1 2\n")
        except ValueError:
            return True
        return False
    chk("REJECTS a short row rather than guessing", rejects_short_row)

    # ── the severity ladder, at and around each boundary ──
    chk("below warn is none", lambda: severity_for(WARN_PCT - 1) == "none")
    chk("AT warn is warning", lambda: severity_for(WARN_PCT) == "warning")
    chk("between warn and crit is warning", lambda: severity_for(CRIT_PCT - 1) == "warning")
    chk("AT crit is critical", lambda: severity_for(CRIT_PCT) == "critical")
    chk("warn is strictly below crit", lambda: WARN_PCT < CRIT_PCT)

    # ── the runway arithmetic ──
    chk("runway is positive well below the threshold",
        lambda: months_to(WARN_PCT, rows[0], 6.95) > 100)
    chk("runway is ZERO once already past the threshold",
        lambda: months_to(10, rows[0], 6.95) == 0.0)
    chk("a zero growth rate is unbounded runway, not a crash",
        lambda: months_to(WARN_PCT, rows[0], 0) == float("inf"))

    # ── verdict → exit-code MAPPING, not just the tokens ──
    chk("PASS maps to 0", lambda: EXIT_FOR["PASS"] == 0)
    chk("FAIL maps to 1", lambda: EXIT_FOR["FAIL"] == 1)
    chk("INDETERMINATE maps to 3", lambda: EXIT_FOR["INDETERMINATE"] == 3)
    chk("worst-of prefers FAIL over PASS", lambda: worst(["PASS", "FAIL"]) == "FAIL")
    chk("worst-of prefers INDETERMINATE over FAIL", lambda: worst(["FAIL", "INDETERMINATE"]) == "INDETERMINATE")
    chk("worst-of an empty list is INDETERMINATE, never PASS", lambda: worst([]) == "INDETERMINATE")

    # ── PROVE IT CAN FAIL: a full filesystem must be reported as failing ──
    full = parse_df(
        "Filesystem     1024-blocks      Used Available Capacity Mounted on\n"
        "/dev/sda1        315621376 300000000  15621376      95% /\n"
    )
    chk("a 95%-full filesystem is critical", lambda: severity_for(int(full[0]["pct_used"])) == "critical")
    chk("a 95%-full filesystem has zero runway", lambda: months_to(WARN_PCT, full[0], 6.95) == 0.0)

    ASSERTION_COUNT = 22
    if len(_ran) != ASSERTION_COUNT:
        failures.append(f"assertion count drifted: ran {len(_ran)}, expected {ASSERTION_COUNT}")

    if failures:
        print(f"SELF-TEST: FAIL ({len(failures)})")
        for f in failures:
            print(f"  - {f}")
        print("DISK_HEADROOM_VERDICT=INDETERMINATE")
        print("DISK_HEADROOM_SEVERITY=none")
        return EXIT_FOR["INDETERMINATE"]
    print(f"SELF-TEST: PASS ({len(_ran)} assertions)")
    print("DISK_HEADROOM_VERDICT=PASS")
    print("DISK_HEADROOM_SEVERITY=none")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    print(f"disk headroom — mounts={','.join(MOUNTS)} warn>={WARN_PCT}% crit>={CRIT_PCT}%")
    verdict, severity, breaches = check()
    if breaches:
        fire("\n".join(
            [f"DISK HEADROOM {severity.upper()} on signal-1.", ""] + breaches + [
                "",
                "DETECT-AND-ALERT ONLY — nothing has been pruned and nothing will be.",
                "Attribute first (read-only): ops/scripts/disk-forensics.sh <ip>",
                "Reclaim is a separate Plan-Mode-gated wave; never an unattended action.",
                "",
                "Retention review for the scorer-input corpus this alarm was commissioned with:",
                "OPS-SCORER-INPUT-RETENTION-W{NEXT} — gated on THIS alert firing, never a date.",
            ]))
    elif verdict == "PASS":
        clear()
    print(f"DISK_HEADROOM_VERDICT={verdict}")
    print(f"DISK_HEADROOM_SEVERITY={severity}")
    return EXIT_FOR[verdict]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

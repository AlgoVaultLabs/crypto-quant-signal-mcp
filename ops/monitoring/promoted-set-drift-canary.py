#!/usr/bin/env python3
"""promoted-set-drift-canary — the static promoted enum vs DB truth vs what we publish.

OPS-BITMART-ENUM-RECONCILE-W1 CH4. BitMart was retired in the `venues` table on 2026-08-27 but
stayed in the compile-time `EXCHANGES` array, so `/api/performance-public` published
`exchange_count: 15` while `byExchange` served 14 — for SEVEN DAYS, on the surface T1 agents read
programmatically. Nothing caught it. `src/lib/capabilities.ts` had claimed a unit test asserted
this parity; that test NEVER EXISTED, and it could not have: the vitest suite runs on SQLite with
no production Postgres, so a parity test written there ships DARK — the exact defect class it
would exist to catch. This canary is the gate that should have existed.

THREE-WAY IDENTITY (architect ruling, 2026-09-03). A one-directional inequality is not enough —
two mismatches that cancel would pass a count check, so every leg is a SET compared by SYMMETRIC
DIFFERENCE, never by cardinality:

    A. container static  PROMOTED_VENUE_IDS   (dist/lib/capabilities.js)
    B. database truth    SELECT exchange_id FROM venues WHERE status='promoted'
    C. published surface /api/performance-public  .byExchange keys   (+ .exchange_count == |A|)

VERDICT TOKEN — the caller gates on the TOKEN, never on the bare exit code:

    PROMOTED_SET_DRIFT_VERDICT=PASS | FAIL | INDETERMINATE

    exit 0 = PASS   ·   exit 1 = FAIL   ·   exit 3 = INDETERMINATE

INDETERMINATE outranks FAIL: "could not verify" must never be reported as the weaker "verified
and fine". VACUITY: an EMPTY set from ANY leg is INDETERMINATE, never PASS — an empty corpus is
only ever "we learned nothing", and this is checked where the corpus is CONSTRUCTED.

READS ONLY. Writes nothing. `send_telegram.sh` owns the cooldown and the severity gate.

    promoted-set-drift-canary.py              # live run
    promoted-set-drift-canary.py --self-test  # hermetic; no DB, no docker, no network
    PSD_REPORT_ONLY=1 ...                     # compute + print, never dispatch (soak mode)
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

PG_CTR = os.environ.get("PSD_PG_CTR", "crypto-quant-signal-mcp-postgres-1")
APP_CTR = os.environ.get("PSD_APP_CTR", "crypto-quant-signal-mcp-mcp-server-1")
PG_ROLE = os.environ.get("PSD_PG_ROLE", "aoe_readonly")
PG_DB = os.environ.get("PSD_PG_DB", "signal_performance")
API_URL = os.environ.get("PSD_API_URL", "https://api.algovault.com/api/performance-public")

TG = os.environ.get("PSD_TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
ALERT_ID = "promoted_set_drift"
SEVERITY_DELIVERED = "CRITICAL_PERSISTENT"

# Report-only soak. The gate is RED-ON-ARRIVAL by design whenever a reconciliation is mid-flight,
# so it ships computing-but-silent, is confirmed clean against the reconciled state, and is only
# then armed. Set to "0"/unset to arm.
REPORT_ONLY = os.environ.get("PSD_REPORT_ONLY", "") in ("1", "true", "yes")

EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
_RANK = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 2}


def worst(verdicts: list[str]) -> str:
    """Worst-of. An EMPTY list is INDETERMINATE — no leg evaluated is the vacuity case one level
    up from an empty corpus."""
    if not verdicts:
        return "INDETERMINATE"
    return max(verdicts, key=lambda v: _RANK[v])


def diff_verdict(label: str, left: set[str], right: set[str]) -> tuple[str, str]:
    """PURE. Compare two sets by SYMMETRIC DIFFERENCE and render the offending ids by name.

    A bare count comparison is the trap this exists to avoid: |A|==|B| holds while A and B differ
    by two cancelling members, and the operator learns nothing from a number anyway. VACUITY is
    checked HERE, where the corpus is constructed — an empty side is INDETERMINATE, not PASS."""
    if not left or not right:
        return "INDETERMINATE", f"{label}: VACUOUS — left={len(left)} right={len(right)} (empty side proves nothing)"
    only_left = sorted(left - right)
    only_right = sorted(right - left)
    if not only_left and not only_right:
        return "PASS", f"{label}: identical ({len(left)} ids)"
    return "FAIL", (
        f"{label}: SYMMETRIC DIFFERENCE — "
        f"only-left={only_left or '[]'} only-right={only_right or '[]'}"
    )


def _run(cmd: list[str], **kw) -> str:
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=60, **kw)
    if out.returncode != 0:
        raise RuntimeError(f"rc={out.returncode}: {out.stderr.strip()[:200]}")
    return out.stdout


def read_static() -> set[str]:
    """Leg A — the compile-time enum as the RUNNING container has it. Deliberately the container's
    dist, not the repo: the question is what production believes, not what main says."""
    raw = _run(["docker", "exec", APP_CTR, "node", "-e",
                "process.stdout.write(JSON.stringify(require('/app/dist/lib/capabilities.js').PROMOTED_VENUE_IDS))"])
    return set(json.loads(raw))


def read_db() -> set[str]:
    """Leg B — DB truth. psql -qtA via argv (never a shell string): -q suppresses the command tag
    that would otherwise be parsed as a row."""
    raw = _run(["docker", "exec", PG_CTR, "psql", "-U", PG_ROLE, "-d", PG_DB, "-qtA",
                "-c", "SELECT exchange_id FROM venues WHERE status = 'promoted' ORDER BY 1"])
    return {ln.strip() for ln in raw.splitlines() if ln.strip()}


def read_published() -> tuple[set[str], int | None]:
    """Leg C — what we actually publish."""
    raw = _run(["curl", "-fsS", "--max-time", "25", API_URL])
    j = json.loads(raw)
    keys = set((j.get("byExchange") or {}).keys())
    ec = j.get("exchange_count")
    return keys, (ec if isinstance(ec, int) else None)


def fire(body: str) -> None:
    """Fail-open: a broken wrapper must never turn a reporting run into a crash."""
    try:
        subprocess.run([TG, ALERT_ID, SEVERITY_DELIVERED, "-"],
                       input=body, text=True, timeout=30, check=False)
    except Exception as e:  # noqa: BLE001
        print(f"[promoted-set-drift] TG dispatch failed (fail-open): {e}", file=sys.stderr)


def clear() -> None:
    """FIRING -> CLEAR state hygiene, not a recovery announcement (`announce_resolution` stays
    false): send_telegram.sh writes its cooldown marker on a delivered fire and nothing else
    removes it, so without this a healed breach pins the channel's last word to the worst state."""
    try:
        subprocess.run([TG, "--clear", ALERT_ID, "promoted set identical across enum/DB/published"],
                       timeout=30, check=False, capture_output=True)
    except Exception as e:  # noqa: BLE001
        print(f"[promoted-set-drift] TG clear failed (fail-open): {e}", file=sys.stderr)


ASSERTION_COUNT = 14


def self_test() -> int:
    """Hermetic — no DB, no docker, no network. Drives the PURE comparison, and PROVES it can
    fail: every must-FAIL case below is a real defect shape this canary has to catch."""
    failures: list[str] = []
    ran: list[str] = []

    def check(name: str, fn) -> None:
        ran.append(name)
        try:
            if not fn():
                failures.append(name)
        except Exception as e:  # noqa: BLE001
            failures.append(f"{name} (raised {e})")

    A = {"HL", "BINANCE", "BYBIT"}
    # must-PASS
    check("identical sets PASS", lambda: diff_verdict("x", A, set(A))[0] == "PASS")
    check("order is irrelevant", lambda: diff_verdict("x", {"A", "B"}, {"B", "A"})[0] == "PASS")
    # must-FAIL — the real defect shapes
    check("extra on the static side FAILs (the BitMart shape)",
          lambda: diff_verdict("x", A | {"BITMART"}, A)[0] == "FAIL")
    check("extra on the DB side FAILs (an unpublished promotion)",
          lambda: diff_verdict("x", A, A | {"WEEX"})[0] == "FAIL")
    check("the failing message NAMES the offending id",
          lambda: "BITMART" in diff_verdict("x", A | {"BITMART"}, A)[1])
    check("TWO CANCELLING mismatches still FAIL (a count check would pass)",
          lambda: diff_verdict("x", A | {"BITMART"}, A | {"WEEX"})[0] == "FAIL")
    check("cancelling case names BOTH sides",
          lambda: ("BITMART" in diff_verdict("x", A | {"BITMART"}, A | {"WEEX"})[1]
                   and "WEEX" in diff_verdict("x", A | {"BITMART"}, A | {"WEEX"})[1]))
    # vacuity — empty is never PASS
    check("empty left is INDETERMINATE", lambda: diff_verdict("x", set(), A)[0] == "INDETERMINATE")
    check("empty right is INDETERMINATE", lambda: diff_verdict("x", A, set())[0] == "INDETERMINATE")
    check("both empty is INDETERMINATE, never PASS",
          lambda: diff_verdict("x", set(), set())[0] == "INDETERMINATE")
    # worst-of ranking
    check("INDETERMINATE outranks FAIL", lambda: worst(["FAIL", "INDETERMINATE"]) == "INDETERMINATE")
    check("FAIL outranks PASS", lambda: worst(["PASS", "FAIL"]) == "FAIL")
    check("empty verdict list is INDETERMINATE", lambda: worst([]) == "INDETERMINATE")
    check("exit codes: PASS0 FAIL1 INDETERMINATE3",
          lambda: (EXIT_FOR["PASS"], EXIT_FOR["FAIL"], EXIT_FOR["INDETERMINATE"]) == (0, 1, 3))

    if len(ran) != ASSERTION_COUNT:
        failures.append(f"assertion count drifted: ran {len(ran)}, ASSERTION_COUNT says {ASSERTION_COUNT}")
    if failures:
        print(f"SELF-TEST: FAIL ({len(failures)})")
        for f in failures:
            print(f"  - {f}")
        print("PROMOTED_SET_DRIFT_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]
    print(f"SELF-TEST: PASS ({ASSERTION_COUNT} assertions)")
    print("PROMOTED_SET_DRIFT_VERDICT=PASS")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()

    lines: list[str] = []
    verdicts: list[str] = []
    try:
        static = read_static()
        db = read_db()
        published, exchange_count = read_published()
    except Exception as e:  # noqa: BLE001
        # An instrument fault is INDETERMINATE and SILENT — never a data verdict.
        print(f"[promoted-set-drift] probe error: {e}", file=sys.stderr)
        print("PROMOTED_SET_DRIFT_VERDICT=INDETERMINATE")
        return EXIT_FOR["INDETERMINATE"]

    for label, l, r in (("A_static_vs_B_db", static, db),
                        ("B_db_vs_C_published", db, published),
                        ("A_static_vs_C_published", static, published)):
        v, msg = diff_verdict(label, l, r)
        verdicts.append(v)
        lines.append(f"  {'✓' if v == 'PASS' else '✗'} {msg}")

    # The published COUNT must equal the published SET. This is the exact defect that ran for 7
    # days: exchange_count is a static .length while byExchange is a live allow-list.
    if exchange_count is None:
        verdicts.append("INDETERMINATE")
        lines.append("  ✗ exchange_count: absent from the payload (cannot verify)")
    elif exchange_count != len(published):
        verdicts.append("FAIL")
        lines.append(f"  ✗ exchange_count={exchange_count} but byExchange has {len(published)} keys")
    else:
        verdicts.append("PASS")
        lines.append(f"  ✓ exchange_count == |byExchange| == {exchange_count}")

    verdict = worst(verdicts)
    print(f"[promoted-set-drift] static={len(static)} db={len(db)} published={len(published)} "
          f"exchange_count={exchange_count}")
    for ln in lines:
        print(ln)

    if REPORT_ONLY:
        print("[promoted-set-drift] PSD_REPORT_ONLY=1 — computed, not dispatched (soak mode)")
    elif verdict == "FAIL":
        fire("🛑 PROMOTED_SET_DRIFT\n"
             "The promoted venue set disagrees across enum / DB / published surface.\n"
             + "\n".join(lines)
             + "\n\nA published count that overstates the served set is a Numerical-Citation breach."
               "\nAction: reconcile src/lib/capabilities.ts EXCHANGES with venues.status='promoted'."
               "\nrecommended_wave: OPS-PROMOTED-SET-RECONCILE-W{NEXT}")
    elif verdict == "PASS":
        clear()

    print(f"PROMOTED_SET_DRIFT_VERDICT={verdict}")
    return EXIT_FOR[verdict]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

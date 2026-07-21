#!/usr/bin/env python3
"""OPS-DIRECTIONAL-LABEL-HALT-W1 — per-venue directional-label freshness canary.

The incident this makes impossible-to-miss: 8 venues' `directional_labels`
production silently starved for 16 days (2026-07-04 → 07-21) while every
venue kept EMITTING signals — nothing compared "venues emitting" against
"venues labelling". This canary is the input/output-counter-mismatch form
(skill: silent-producer-halt-via-input-output-counter-mismatch): it fires
ONLY when a venue's signals are ACCRUING (input flowing) and its newest
labeled signal lags beyond the tier SLO (output stuck).

Two-tier SLO (Mr.1 venue policy 2026-07-21, wave spec R4):
  * MAJORS  {BINANCE, BYBIT, OKX, BITGET, HL} — <24h; pages via
    send_telegram.sh AFTER 2 CONSECUTIVE daily breaches (the sustained-drift
    criterion; the wrapper owns severity/cooldown/DRY_RUN/fail-open gates —
    consumers MUST NOT re-implement those).
  * LONG-TAIL (everything else; new venues default here) — <72h; digest
    line only, never pages.

Cron: 41 6 * * * (off-:00; after the nightly labeler budget window ends).
State: /var/lib/algovault-monitoring/label-freshness-state.json
Digest artifact (all venues, every run): /var/lib/algovault-monitoring/label-freshness-digest.txt
Log: /var/log/directional-label-freshness.log (cron appends)

Reads postgres HOST-SIDE via `docker exec <pg-ctr> psql -tA -F'|'` (the
host-bash psql pattern — never `node -e`). Fail-open: any probe/IO error
logs and exits 0 (cron retries tomorrow; the labeler itself is unaffected).

Test seams (hermetic suite: test-directional-label-freshness.py):
  LF_PSQL_CMD    override the psql command (default: docker exec … psql …)
  LF_STATE_FILE  state path        LF_DIGEST_FILE digest path
  LF_WRAPPER     send_telegram.sh path
  LF_NOW_EPOCH   freeze "now"      --force-stale VENUE  synthetic breach
                                   (pair with DRY_RUN_TG=1 — runbook §6)

Thresholds carry `defensive-reductions-to-revisit.md` rows.
TODO: revisit by 2026-08-04 — tier SLOs vs 30d of observed lag telemetry.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

MAJORS = {"BINANCE", "BYBIT", "OKX", "BITGET", "HL"}
MAJOR_SLO_H = 24
LONGTAIL_SLO_H = 72
INPUT_FLOWING_H = 48          # venue must have >=1 eligible signal this recent
CONSECUTIVE_TO_PAGE = 2       # sustained-drift criterion (majors only)
BARRIER_SPEC = "tau1.0-floor0.30-v1"

ALERT_ID = "DIRECTIONAL_LABEL_FRESHNESS_BREACH"
SEVERITY = "CRITICAL_PERSISTENT"  # design-time classification: sustained
# data-pipeline death needing an operator dispatch (runbook contract #4).

# NOTE: no -F flag — psql's unaligned default separator already IS `|`, and this
# command is split() for subprocess (NO shell), so a quoted -F'|' would reach
# psql with LITERAL quotes and silently break every row (caught by live smoke).
PSQL_DEFAULT = (
    "docker exec crypto-quant-signal-mcp-postgres-1 "
    "psql -U algovault -d signal_performance -tA"
)

CENSUS_SQL = (
    "SET default_transaction_read_only=on; "
    "SELECT s.exchange, MAX(s.created_at) AS newest_signal, "
    "MAX(s.created_at) FILTER (WHERE d.signal_id IS NOT NULL) AS newest_labeled "
    "FROM signals s LEFT JOIN directional_labels d "
    f"ON d.signal_id = s.id AND d.barrier_spec = '{BARRIER_SPEC}' "
    "WHERE s.signal IN ('BUY','SELL') AND s.pfe_return_pct IS NOT NULL "
    "AND s.timeframe <> '1m' GROUP BY 1 ORDER BY 1;"
)


def now_epoch() -> int:
    return int(os.environ.get("LF_NOW_EPOCH") or time.time())


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} [label-freshness] {msg}")


def census() -> list[tuple[str, int, int | None]]:
    cmd = os.environ.get("LF_PSQL_CMD", PSQL_DEFAULT)
    out = subprocess.run(
        cmd.split() + ["-c", CENSUS_SQL], capture_output=True, text=True, timeout=120
    )
    if out.returncode != 0:
        raise RuntimeError(f"psql failed rc={out.returncode}: {out.stderr.strip()[:200]}")
    rows: list[tuple[str, int, int | None]] = []
    for line in out.stdout.strip().splitlines():
        if "|" not in line:
            continue  # SET tag / noise
        venue, newest_sig, newest_lab = (line.split("|") + [""])[:3]
        if not venue or not newest_sig.strip().isdigit():
            continue
        rows.append((venue.strip(), int(newest_sig), int(newest_lab) if newest_lab.strip().isdigit() else None))
    return rows


def evaluate(rows, force_stale: str | None, now: int):
    """Pure classification: returns (digest_lines, major_breaches, longtail_breaches)."""
    digest, majors_bad, tail_bad = [], [], []
    for venue, newest_sig, newest_lab in sorted(rows):
        tier = "major" if venue in MAJORS else "long-tail"
        slo_h = MAJOR_SLO_H if venue in MAJORS else LONGTAIL_SLO_H
        input_flowing = (now - newest_sig) <= INPUT_FLOWING_H * 3600
        lag_h = (now - newest_lab) / 3600 if newest_lab else float("inf")
        if force_stale and venue == force_stale:
            lag_h, input_flowing = 999.0, True  # synthetic breach (DRY_RUN_TG smoke)
        breach = input_flowing and lag_h > slo_h
        mark = "BREACH" if breach else ("idle" if not input_flowing else "ok")
        lag_s = "never" if lag_h == float("inf") else f"{lag_h:.1f}h"
        digest.append(f"{venue:9s} {tier:9s} lag={lag_s:>8s} slo={slo_h}h {mark}")
        if breach:
            (majors_bad if venue in MAJORS else tail_bad).append((venue, lag_s))
    return digest, majors_bad, tail_bad


def build_alert_body(majors_bad, consecutive: dict[str, int]) -> str:
    lines = [f"🛑 {ALERT_ID}",
             f"Directional-label freshness SLO breach on MAJOR venue(s): "
             + ", ".join(f"{v} lag={s} (>{MAJOR_SLO_H}h)" for v, s in majors_bad),
             "Context: signals ARE accruing on these venues while labels lag — the "
             "silent-producer-halt class; consecutive daily fails: "
             + ", ".join(f"{v}={consecutive.get(v, 0)}" for v, _ in majors_bad)
             + f" (pages at {CONSECUTIVE_TO_PAGE}).",
             "Action: dispatch OPS-LABEL-FRESHNESS-W{NEXT} via Cowork → Claude Code",
             "Audit shape: audits/OPS-DIRECTIONAL-LABEL-HALT-W1-endpoint-truth.md",
             "Source log: /var/log/directional-label-freshness.log"]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    force_stale = None
    if "--force-stale" in argv:
        i = argv.index("--force-stale")
        force_stale = argv[i + 1] if i + 1 < len(argv) else None
        if os.environ.get("DRY_RUN_TG") != "1":
            log("REFUSING --force-stale without DRY_RUN_TG=1 (runbook §6: synthetic fires are silent)")
            return 0
    state_file = Path(os.environ.get("LF_STATE_FILE", "/var/lib/algovault-monitoring/label-freshness-state.json"))
    digest_file = Path(os.environ.get("LF_DIGEST_FILE", "/var/lib/algovault-monitoring/label-freshness-digest.txt"))
    wrapper = os.environ.get("LF_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")

    try:
        rows = census()
    except Exception as exc:  # fail-open: probe failure never pages, never bounces cron
        log(f"FAIL_OPEN census error: {exc}")
        return 0
    if not rows:
        log("FAIL_OPEN census returned 0 parseable rows (separator/shape drift? re-check psql cmd)")
        return 0

    now = now_epoch()
    digest, majors_bad, tail_bad = evaluate(rows, force_stale, now)

    try:
        state = json.loads(state_file.read_text()) if state_file.exists() else {}
    except Exception:
        state = {}
    prior: dict[str, int] = state.get("consecutive", {})
    # A healed venue drops out of state entirely (no zero-key accumulation);
    # only currently-breaching MAJORS are tracked (long-tail never pages).
    consecutive = {v: prior.get(v, 0) + 1 for v in {v for v, _ in majors_bad}}

    for line in digest:
        log(f"digest {line}")
    for v, s in tail_bad:
        log(f"LONGTAIL_BREACH {v} lag={s} (digest-only by tier policy — never pages)")

    to_page = [(v, s) for v, s in majors_bad if consecutive.get(v, 0) >= CONSECUTIVE_TO_PAGE]
    if to_page:
        body = build_alert_body(to_page, consecutive)
        try:
            subprocess.run([wrapper, ALERT_ID, SEVERITY, "-"], input=body, text=True, timeout=60)
            log(f"PAGE_SENT_TO_WRAPPER majors={[v for v, _ in to_page]} (wrapper owns cooldown/DRY_RUN gates)")
        except Exception as exc:
            log(f"FAIL_OPEN wrapper error: {exc}")
    elif majors_bad:
        log(f"MAJOR_BREACH_DAY_1 {[v for v, _ in majors_bad]} — sustained-drift gate holds page until day {CONSECUTIVE_TO_PAGE}")

    try:
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps({"consecutive": consecutive, "updated": now}, indent=1))
        digest_file.parent.mkdir(parents=True, exist_ok=True)
        digest_file.write_text("\n".join(digest) + "\n")
    except Exception as exc:
        log(f"FAIL_OPEN state/digest write error: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""
recommendation-drift-canary.py — OPS-MONITORING-RECOMMENDATION-RESOLVER-AND-CANARY-W1 C4

Self-policing canary on hardcoded OPS-X-Y-W<N> recommendation drift in monitoring
scripts. Fires MONITORING_SCRIPT_RECOMMENDATION_DRIFT_<alert_class> via the
send_telegram.sh wrapper when a hardcoded W<N> reference is <= the highest GREEN
W<N> for that class in status.md (i.e. drifted — should have been migrated to
the W{NEXT} template form so the wrapper auto-resolves it).

Cron: Tue 12:00 UTC (1d staggered from website-drift-canary on Mondays).

Honors:
  - DRY_RUN_TG=1 — wrapper PATCH-A gate (writes cooldown marker but skips TG POST).
  - MANIFEST_OVERRIDE=<path> — use a different manifest (used by synthetic
    regression smoke + future test seams).

Per OPS-MONITORING-TG-W1 contract: severity = CRITICAL_PERSISTENT only; 24h
cooldown per alert_id; fail-open exit 0 on every error path; body shape carries
(a) alert_id header, (b) drift summary, (c) suggested sed fix verbatim,
(d) recommended_wave (template form), (e) audit-doc reference, (f) source log.

Reference: audits/OPS-MONITORING-RECOMMENDATION-RESOLVER-AND-CANARY-W1-endpoint-truth.md
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Iterator

try:
    import yaml
except ImportError:
    print("FATAL: pyyaml not installed", file=sys.stderr)
    sys.exit(0)  # fail-open

WRAPPER = "/opt/algovault-monitoring/send_telegram.sh"
DEFAULT_MANIFEST = "/opt/algovault-monitoring/recommendation-drift-manifest.yaml"
STATUS_MD = "/var/lib/algovault-monitoring/status.md"
LOG_FILE = "/var/log/recommendation-drift-canary.log"
AUDIT_DOC = "audits/OPS-MONITORING-RECOMMENDATION-RESOLVER-AND-CANARY-W1-endpoint-truth.md"


def setup_logging() -> None:
    Path(LOG_FILE).parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=LOG_FILE,
        level=logging.INFO,
        format="%(asctime)sZ %(levelname)s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )


def find_hardcoded(script_path: str, hardcoded_regex: str) -> Iterator[tuple[int, str, int]]:
    """Yield (line_no, full_match, W_number) for each hardcoded match in file."""
    pattern = re.compile(hardcoded_regex)
    try:
        with open(script_path, "r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f, 1):
                # Skip lines that already use template form (contain W{NEXT})
                if "W{NEXT}" in line:
                    # check if pattern matches non-template part too
                    for m in pattern.finditer(line):
                        full = m.group(0)
                        if "{NEXT}" in full:
                            continue
                        W_num = int(m.group(1)) if m.lastindex and m.lastindex >= 1 else 0
                        yield i, full, W_num
                    continue
                for m in pattern.finditer(line):
                    full = m.group(0)
                    if "{NEXT}" in full:
                        continue
                    W_num = int(m.group(1)) if m.lastindex and m.lastindex >= 1 else 0
                    yield i, full, W_num
    except OSError as e:
        logging.warning("READ_FAILED script_path=%s err=%s", script_path, e)


def find_highest_green(status_md_path: str, status_md_regex: str) -> int:
    """Return highest W<N> across all matching GREEN heading lines in status.md."""
    pattern = re.compile(status_md_regex)
    highest = 0
    try:
        with open(status_md_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                m = pattern.match(line)
                if m and m.lastindex and m.lastindex >= 1:
                    try:
                        w = int(m.group(1))
                    except (ValueError, TypeError):
                        continue
                    if w > highest:
                        highest = w
    except OSError as e:
        logging.warning("STATUS_MD_UNREADABLE path=%s err=%s", status_md_path, e)
    return highest


def fire_alert(alert_id: str, body: str) -> int:
    """Pipe body to wrapper via subprocess. Wrapper honors DRY_RUN_TG. Fail-open."""
    try:
        proc = subprocess.run(
            [WRAPPER, alert_id, "CRITICAL_PERSISTENT", "-"],
            input=body,
            text=True,
            capture_output=True,
            timeout=30,
        )
        return proc.returncode
    except (subprocess.TimeoutExpired, OSError) as e:
        logging.warning("WRAPPER_INVOCATION_FAILED alert_id=%s err=%s", alert_id, e)
        return 0  # fail-open


def build_body(alert_id: str, row: dict, drifted: list[tuple[int, str, int]], highest_green: int) -> str:
    script_path = row["script_path"]
    recommended_wave = row["recommended_wave"]
    lines: list[str] = []
    lines.append(f"🛑 {alert_id}")
    lines.append(f"Condition: hardcoded recommended_wave drift detected")
    lines.append(f"Script: {script_path}")
    lines.append(f"Highest GREEN W<N> in status.md for class: W{highest_green}")
    lines.append(f"Drifted references ({len(drifted)}):")
    for line_no, matched_str, matched_W in drifted[:10]:  # cap to 10 to keep body sane
        lines.append(f"  L{line_no}: {matched_str} (matched_W={matched_W} <= highest_green_W={highest_green})")
    if len(drifted) > 10:
        lines.append(f"  ... (+{len(drifted) - 10} more)")
    if drifted:
        first_str = drifted[0][1]
        # strip -W<N> suffix to compute class prefix
        class_prefix = re.sub(r"-W\d+$", "", first_str)
        lines.append(f"Suggested fix: sed -i 's|{first_str}|{class_prefix}-W{{NEXT}}|g' {script_path}")
    lines.append(f"Action: dispatch {recommended_wave} via Cowork → Claude Code")
    lines.append(f"Audit shape: {AUDIT_DOC}")
    lines.append(f"Source log: {LOG_FILE}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default=os.environ.get("MANIFEST_OVERRIDE", DEFAULT_MANIFEST))
    parser.add_argument("--status-md", default=STATUS_MD)
    args = parser.parse_args()

    setup_logging()
    logging.info("CANARY_START manifest=%s status_md=%s", args.manifest, args.status_md)

    try:
        with open(args.manifest, "r", encoding="utf-8") as f:
            manifest = yaml.safe_load(f)
    except (OSError, yaml.YAMLError) as e:
        logging.error("MANIFEST_LOAD_FAILED path=%s err=%s", args.manifest, e)
        return 0  # fail-open

    rows = manifest.get("rows", []) if manifest else []
    if not rows:
        logging.warning("MANIFEST_EMPTY path=%s", args.manifest)
        return 0

    drift_count = 0
    rows_checked = 0
    rows_skipped = 0

    for row in rows:
        rows_checked += 1
        try:
            alert_class = row["alert_class"]
            script_path = row["script_path"]
            hardcoded_regex = row["hardcoded_template_regex"]
            status_regex = row["status_md_completion_regex"]
        except KeyError as e:
            logging.warning("ROW_MALFORMED missing=%s row=%s", e, row)
            rows_skipped += 1
            continue

        if not Path(script_path).exists():
            logging.warning("ROW_SKIPPED class=%s script_path=%s (not found)", alert_class, script_path)
            rows_skipped += 1
            continue

        highest_green = find_highest_green(args.status_md, status_regex)
        logging.info("CHECKING class=%s script=%s highest_green_W=%d", alert_class, script_path, highest_green)

        drifted: list[tuple[int, str, int]] = []
        for line_no, matched_str, matched_W in find_hardcoded(script_path, hardcoded_regex):
            if matched_W <= highest_green:
                drifted.append((line_no, matched_str, matched_W))

        if drifted:
            drift_count += 1
            alert_id = f"MONITORING_SCRIPT_RECOMMENDATION_DRIFT_{alert_class}"
            body = build_body(alert_id, row, drifted, highest_green)
            logging.info("FIRING alert_id=%s drifts=%d", alert_id, len(drifted))
            rc = fire_alert(alert_id, body)
            logging.info("FIRED alert_id=%s wrapper_rc=%d", alert_id, rc)
        else:
            logging.info("CLEAN class=%s (no drifted hardcoded references)", alert_class)

    logging.info(
        "CANARY_DONE rows_checked=%d rows_skipped=%d drift_count=%d",
        rows_checked, rows_skipped, drift_count,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

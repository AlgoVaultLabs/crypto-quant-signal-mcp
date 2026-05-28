#!/usr/bin/env python3
"""
ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28): Activation funnel leak detector.

Reads the last 7 days of `activation-funnel/snapshots/<DATE>-auto.json`
(written weekly by the algovault-funnel-snapshot.service systemd unit on
Hetzner) + computes per-stage week-over-week retention drop. Emits a
CRITICAL_PERSISTENT Telegram alert via /opt/algovault-monitoring/send_telegram.sh
when ANY of:

  (a) Any 14-stage transition drops ≥40% WoW (this week vs prior week).
  (b) Overall install_to_first_call retention drops below 0.20% (current
      baseline is 0.29%; below 0.20% = leak worsened materially).

Alert body includes the recommended_wave template `OPS-ACTIVATION-LEAK-FIX-W{NEXT}`
(per CLAUDE.md `Hardcoded recommended_wave strings FORBIDDEN` rule); the
send_telegram.sh wrapper's PATCH-B resolver expands `{NEXT}` to the next
W<N> for the OPS-ACTIVATION-LEAK-FIX class via status.md grep.

Exit codes:
  0  — silent (no alert needed; OR alert emitted successfully via wrapper)
  1  — error (snapshot dir missing, malformed JSON, wrapper failure); logged
       to stderr

Env vars:
  DRY_RUN_AUTOPILOT=1   — first-fire safety: classify + emit body to stdout
                          without invoking wrapper (per CLAUDE.md
                          `dry-run-autopilot-first-fire-safety-gate-catches-
                          classifier-mis-calibration-pre-prod` rule).
  DRY_RUN_TG=1          — exercises wrapper but skips actual TG POST
                          (forwarded to wrapper; cooldown marker still written).
  SNAPSHOTS_DIR         — override default
                          `/opt/crypto-quant-signal-mcp/activation-funnel/snapshots`.
  WRAPPER_PATH          — override default
                          `/opt/algovault-monitoring/send_telegram.sh`.

Reference: audits/ACTIVATION-FUNNEL-AUDIT-W1-endpoint-truth.md
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ── Configuration ──

DEFAULT_SNAPSHOTS_DIR = "/opt/crypto-quant-signal-mcp/activation-funnel/snapshots"
DEFAULT_WRAPPER_PATH = "/opt/algovault-monitoring/send_telegram.sh"
ALERT_ID = "ACTIVATION_FUNNEL_LEAK_DETECTED"
WAVE_TEMPLATE = "OPS-ACTIVATION-LEAK-FIX-W{NEXT}"
AUDIT_DOC = "audits/ACTIVATION-FUNNEL-AUDIT-W1-endpoint-truth.md"

# Alert thresholds (architect-ratified Q-F).
WOW_DROP_THRESHOLD = 0.40  # any stage transition dropping ≥40% WoW
INSTALL_TO_CALL_FLOOR = 0.0020  # 0.20%; current baseline ≈ 0.29%

# Canonical 14-stage order (matches FunnelSnapshot interface).
STAGE_ORDER = [
    "install",
    "mcp_tools_list",
    "first_call",
    "quota_hit_soft",
    "quota_hit_hard",
    "quota_hit_block",
    "upgrade_cta_clicked",
    "stripe_checkout_started",
    "paid_upgrade",
    "tg_bot_start",
    "tg_bot_first_command",
    "tg_bot_watchlist_add",
    "tg_bot_quota_hit",
    "tg_bot_upgrade_clicked",
]


def log(msg: str) -> None:
    """Emit a structured log line to stderr (journald-friendly)."""
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"[funnel-leak-detector {ts}] {msg}", file=sys.stderr, flush=True)


def list_snapshots(snapshots_dir: Path) -> list[Path]:
    """Return all `<YYYY-MM-DD>-auto.json` snapshots sorted by date (ascending).
    Manual / dryrun tag files are ignored — only auto-cadence snapshots
    enter the WoW comparison."""
    if not snapshots_dir.is_dir():
        raise FileNotFoundError(f"snapshots dir does not exist: {snapshots_dir}")
    out: list[Path] = []
    for p in sorted(snapshots_dir.glob("*-auto.json")):
        # Filename shape: 2026-05-25-auto.json — pick the 10-char date prefix.
        name = p.name
        if len(name) < 10 or name[4] != "-" or name[7] != "-":
            continue
        out.append(p)
    return out


def load_snapshot(path: Path) -> dict[str, Any]:
    """Read + parse a snapshot JSON file."""
    return json.loads(path.read_text(encoding="utf-8"))


def safe_ratio(numer: Any, denom: Any) -> float | None:
    """Compute a non-null retention ratio, or None when either side is
    null/zero/non-numeric."""
    if numer is None or denom is None:
        return None
    if not isinstance(numer, (int, float)) or not isinstance(denom, (int, float)):
        return None
    if denom == 0:
        return None
    return float(numer) / float(denom)


def compute_alert_conditions(
    current: dict[str, Any], previous: dict[str, Any] | None
) -> tuple[bool, list[str]]:
    """Determine whether the current snapshot triggers an alert.

    Returns ``(alert_should_fire, reasons)`` where reasons is a list of
    one-line human-readable trigger descriptions.

    Conditions:
      (a) Install-to-first-call drops below INSTALL_TO_CALL_FLOOR.
      (b) Any stage-to-stage transition retention drops ≥WOW_DROP_THRESHOLD
          (40%) week-over-week vs previous snapshot.
    """
    reasons: list[str] = []

    # Condition (a): install_to_first_call floor breach (one-snapshot check).
    funnel = current.get("funnel") or {}
    install = funnel.get("install")
    first_call = funnel.get("first_call")
    install_to_call = safe_ratio(first_call, install)
    if install_to_call is not None and install_to_call < INSTALL_TO_CALL_FLOOR:
        reasons.append(
            f"install_to_first_call {install_to_call:.4%} < floor {INSTALL_TO_CALL_FLOOR:.2%} "
            f"({first_call}/{install})"
        )

    # Condition (b): WoW retention drop in any stage transition.
    if previous is not None:
        cur_retentions = current.get("stage_retentions") or {}
        prev_retentions = previous.get("stage_retentions") or {}
        for i in range(1, len(STAGE_ORDER)):
            key = f"{STAGE_ORDER[i - 1]}_to_{STAGE_ORDER[i]}"
            cur = cur_retentions.get(key)
            prev = prev_retentions.get(key)
            if cur is None or prev is None:
                continue
            if not isinstance(cur, (int, float)) or not isinstance(prev, (int, float)):
                continue
            if prev <= 0:
                continue
            drop = (prev - cur) / prev  # positive = degradation
            if drop >= WOW_DROP_THRESHOLD:
                reasons.append(
                    f"{key} retention dropped {drop:.1%} WoW "
                    f"(this week {cur:.3%}, prev week {prev:.3%})"
                )

    return (len(reasons) > 0, reasons)


def format_alert_body(
    current: dict[str, Any],
    previous: dict[str, Any] | None,
    reasons: list[str],
    snapshots_used: list[str],
) -> str:
    """Compose the Telegram alert body per the operator-action-required
    contract (CLAUDE.md `## Automation-first recovery → Operator-action-
    required alert contract`). Recommended-wave template stays in `{NEXT}`
    form — send_telegram.sh wrapper PATCH-B resolves at fire time."""
    funnel = current.get("funnel") or {}
    weakest = current.get("weakest_stage_transition") or {}
    weakest_summary = ""
    if weakest and weakest.get("retention") is not None:
        weakest_summary = (
            f"\nWeakest stage transition: "
            f"{weakest.get('from')} → {weakest.get('to')} at "
            f"{float(weakest.get('retention') or 0):.3%}"
        )

    install = funnel.get("install")
    first_call = funnel.get("first_call")
    install_to_call = safe_ratio(first_call, install)
    install_to_call_str = (
        f"{install_to_call:.4%}" if install_to_call is not None else "—"
    )

    snapshot_window = current.get("window") or {}
    window_from = snapshot_window.get("from", "?")
    window_to = snapshot_window.get("to", "?")

    reasons_block = "\n".join(f"  - {r}" for r in reasons) if reasons else "  - (none)"

    return (
        f"🛑 {ALERT_ID}\n"
        f"Window: {window_from} → {window_to}\n"
        f"Install ({install}) → first_call ({first_call}) = {install_to_call_str}"
        f"{weakest_summary}\n"
        f"\nTrigger reasons:\n{reasons_block}\n"
        f"\nAction: dispatch {WAVE_TEMPLATE} via Cowork → Claude Code\n"
        f"Audit shape: {AUDIT_DOC}\n"
        f"Snapshots compared: {', '.join(snapshots_used)}\n"
        f"Source log: /var/log/algovault-funnel-leak-detector.log\n"
    )


def invoke_wrapper(wrapper_path: Path, body: str) -> int:
    """Pipe-subprocess invoke the canonical send_telegram.sh wrapper. Per
    CLAUDE.md `wrapper-pure-pipe-subprocess-contract-3rd-consumer-confirmed`
    rule: zero gate re-implementation in the consumer; wrapper handles
    severity-gate, cooldown-gate, env-load, fail-open, and template-resolver
    semantics inline.
    """
    try:
        result = subprocess.run(
            [str(wrapper_path), ALERT_ID, "CRITICAL_PERSISTENT", "-"],
            input=body,
            encoding="utf-8",
            timeout=15,
            check=False,
        )
        return result.returncode
    except Exception as e:
        log(f"wrapper invocation failed: {e}")
        return 1


def main() -> int:
    snapshots_dir = Path(os.environ.get("SNAPSHOTS_DIR", DEFAULT_SNAPSHOTS_DIR))
    wrapper_path = Path(os.environ.get("WRAPPER_PATH", DEFAULT_WRAPPER_PATH))
    dry_run_autopilot = os.environ.get("DRY_RUN_AUTOPILOT") == "1"

    try:
        snapshots = list_snapshots(snapshots_dir)
    except FileNotFoundError as e:
        log(f"FATAL: {e}")
        return 1

    if not snapshots:
        log(f"no -auto.json snapshots found in {snapshots_dir} — nothing to compare")
        return 0

    # Compare the latest snapshot against the previous one (chronologically).
    current_path = snapshots[-1]
    previous_path = snapshots[-2] if len(snapshots) >= 2 else None
    log(
        f"comparing current={current_path.name} vs "
        f"previous={previous_path.name if previous_path else '<none — first snapshot>'}"
    )

    try:
        current = load_snapshot(current_path)
    except Exception as e:
        log(f"FATAL: failed to load current snapshot {current_path}: {e}")
        return 1

    previous: dict[str, Any] | None = None
    if previous_path is not None:
        try:
            previous = load_snapshot(previous_path)
        except Exception as e:
            log(f"WARN: failed to load previous snapshot {previous_path}: {e}")
            previous = None

    snapshots_used = [current_path.name]
    if previous_path is not None and previous is not None:
        snapshots_used.append(previous_path.name)

    should_fire, reasons = compute_alert_conditions(current, previous)
    if not should_fire:
        log("no alert conditions met — silent exit")
        return 0

    body = format_alert_body(current, previous, reasons, snapshots_used)
    log(f"alert conditions met ({len(reasons)} reason(s)); preparing wrapper invocation")
    log(f"reasons: {reasons}")

    if dry_run_autopilot:
        log("DRY_RUN_AUTOPILOT=1 — emitting body to stdout WITHOUT wrapper invocation")
        print(body)
        return 0

    rc = invoke_wrapper(wrapper_path, body)
    log(f"wrapper exit code: {rc}")
    return rc


if __name__ == "__main__":
    sys.exit(main())

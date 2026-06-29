#!/usr/bin/env python3
"""
ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28); 4-gate guard: OPS-ACTIVATION-LEAK-FIX-W1
CH4 (2026-06-29). Activation-funnel leak detector.

Reads the last few `activation-funnel/snapshots/<DATE>-auto.json` (written weekly
by the algovault-funnel-snapshot.service systemd unit on Hetzner) and decides
whether a REAL, statistically-significant, PERSISTENT activation leak occurred —
suppressing the measurement artifacts the raw %-delta trigger used to false-fire
on. Emits a CRITICAL_PERSISTENT Telegram alert via
/opt/algovault-monitoring/send_telegram.sh only when the 4 gates all clear.

Why this was rewritten (audits/OPS-ACTIVATION-LEAK-FIX-W1-endpoint-truth.md):
the prior trigger was (a) an install_to_first_call < 0.20% FLOOR (DEAD — live is
~25%, a 100x miscalibration) and (b) ANY stage transition dropping >=40% WoW — a
raw ratio of tiny counts. On 2026-06-29 it fired on `tg_bot_start ->
tg_bot_first_command` 2/7 -> 0/7 (small-N noise; Fisher p=0.475) while surfacing
`install -> mcp_tools_list = 0` (a STRUCTURAL artifact — tools/list was never
captured) as the weakest transition. Neither is a leak.

The 4 gates (architect-ratified Q-F defaults; gate the ALARM, never hide the data
— every status carries absolute counts):
  Gate 0  NO_DATA            — structurally-zero / un-captured downstream, OR an
                               UN-CLEANABLE upstream. `install` is npm-registry
                               downloads (Q2): a cross-source count, NOT a
                               behavioral population, so raw install->X WoW ratios
                               are suppressed. The cleaned activation signal is
                               `by_authenticity.human_first_call_pct` (CH3),
                               evaluated separately when present.
  Gate 1  INSUFFICIENT_SAMPLE— current denominator n < N_MIN (30) OR baseline
                               conversions < C_MIN (5). (Kills the 7-sample tg_bot
                               transition.) Reports raw counts only.
  Gate 2  significance       — Wilson-score 95% CI non-overlap (Brown/Cai/DasGupta
                               2001) AND relative drop >= MDE (30%). NOT a %-delta.
  Gate 3  persistence        — the drop must be significant for >= PERSISTENCE (2)
                               CONSECUTIVE WoW cycles (needs 3 snapshots). A single
                               down-week is `watching`, not an alert. The 7-day
                               COOLDOWN is enforced by send_telegram.sh (NOT
                               re-implemented here — consume the wrapper).

Reads the new CH2/CH3 snapshot fields (`identity_coverage`, `by_authenticity`)
defensively (absent on pre-deploy snapshots -> the cleaned-activation check is
simply skipped), so the same script runs against old and new snapshots.

Alert body includes the recommended_wave template `OPS-ACTIVATION-LEAK-FIX-W{NEXT}`
(per CLAUDE.md `Hardcoded recommended_wave strings FORBIDDEN`); the
send_telegram.sh wrapper's PATCH-B resolver expands `{NEXT}` at fire time.

Exit codes:
  0  — silent (no alert needed; OR alert emitted successfully via wrapper)
  1  — error (snapshot dir missing, malformed JSON, wrapper failure); logged to stderr

Env vars:
  DRY_RUN_AUTOPILOT=1   — first-fire safety: classify + emit body to stdout WITHOUT
                          invoking the wrapper.
  DRY_RUN_TG=1          — exercises wrapper but skips the actual TG POST.
  SNAPSHOTS_DIR         — override default snapshots dir.
  WRAPPER_PATH          — override default send_telegram.sh path.

Reference: audits/ACTIVATION-FUNNEL-AUDIT-W1-endpoint-truth.md +
           audits/OPS-ACTIVATION-LEAK-FIX-W1-endpoint-truth.md
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# ── Configuration ──

DEFAULT_SNAPSHOTS_DIR = "/opt/crypto-quant-signal-mcp/activation-funnel/snapshots"
DEFAULT_WRAPPER_PATH = "/opt/algovault-monitoring/send_telegram.sh"
ALERT_ID = "ACTIVATION_FUNNEL_LEAK_DETECTED"
WAVE_TEMPLATE = "OPS-ACTIVATION-LEAK-FIX-W{NEXT}"
AUDIT_DOC = "audits/OPS-ACTIVATION-LEAK-FIX-W1-endpoint-truth.md"

# 4-gate thresholds (architect-ratified Q-F). Each is a policy knob — re-audit
# against the live funnel mix and bump the date.
N_MIN = 30           # Gate 1: min current denominator (sessions).   # TODO: revisit by 2026-09-27
C_MIN = 5            # Gate 1: min baseline conversions.              # TODO: revisit by 2026-09-27
ALPHA = 0.05         # Gate 2: 95% CI (two-sided).                    # TODO: revisit by 2026-09-27
MDE = 0.30           # Gate 2: min RELATIVE drop (practical signif.). # TODO: revisit by 2026-09-27
PERSISTENCE = 2      # Gate 3: consecutive significant WoW cycles.    # TODO: revisit by 2026-09-27
COOLDOWN_DAYS = 7    # Gate 3: cooldown — ENFORCED BY send_telegram.sh wrapper, NOT here.

# z for a two-sided 95% interval (ALPHA=0.05). Hardcoded for the default; recompute
# if ALPHA changes (no scipy on the host).
Z_95 = 1.959963984540054

# `install` is npm-registry downloads — a cross-source count with no per-download
# UA/IP (Q2: structurally un-cleanable). Raw install->X WoW ratios are NOT a
# behavioral activation signal and are suppressed at Gate 0. The cleaned signal is
# by_authenticity.human_first_call_pct.
UNCLEANABLE_UPSTREAM = {"install"}

# Status constants (gate the alarm, not the data — every status carries counts).
NO_DATA = "NO_DATA"
INSUFFICIENT_SAMPLE = "INSUFFICIENT_SAMPLE"
OK = "OK"
LEAK = "LEAK"

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


def list_snapshots(snapshots_dir: Path) -> list:
    """Return all `<YYYY-MM-DD>-auto.json` snapshots sorted by date (ascending).
    Manual / dryrun tag files are ignored — only auto-cadence snapshots enter the
    comparison."""
    if not snapshots_dir.is_dir():
        raise FileNotFoundError(f"snapshots dir does not exist: {snapshots_dir}")
    out = []
    for p in sorted(snapshots_dir.glob("*-auto.json")):
        name = p.name
        if len(name) < 10 or name[4] != "-" or name[7] != "-":
            continue
        out.append(p)
    return out


def load_snapshot(path: Path) -> dict:
    """Read + parse a snapshot JSON file."""
    return json.loads(path.read_text(encoding="utf-8"))


def _num(value: Any) -> Optional[float]:
    """Return value as a float when it is a finite number, else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(float(value)) else None
    return None


def stage_count(snap: dict, stage: str) -> Optional[float]:
    """funnel[stage] as a number, or None when null/missing/non-numeric."""
    funnel = snap.get("funnel") or {}
    return _num(funnel.get(stage))


def wilson_ci(x: float, n: float, z: float = Z_95) -> tuple:
    """Wilson score CI for a binomial proportion x/n. Returns (lo, hi) clamped to
    [0,1]. Defensive: n<=0 -> the widest interval (0,1) (no information)."""
    if n <= 0:
        return (0.0, 1.0)
    p = x / n
    denom = 1.0 + (z * z) / n
    center = (p + (z * z) / (2.0 * n)) / denom
    half = (z / denom) * math.sqrt(p * (1.0 - p) / n + (z * z) / (4.0 * n * n))
    return (max(0.0, center - half), min(1.0, center + half))


def is_significant_drop(
    to_curr: float, from_curr: float, to_prev: float, from_prev: float
) -> tuple:
    """Gate 2: a drop curr_rate < prev_rate is significant iff the Wilson 95% CIs
    do NOT overlap (curr upper < prev lower) AND the RELATIVE drop >= MDE. Returns
    (significant: bool, detail: str). Pure / default-deny on a non-drop."""
    if from_curr <= 0 or from_prev <= 0:
        return (False, "zero denominator")
    curr_rate = to_curr / from_curr
    prev_rate = to_prev / from_prev
    if curr_rate >= prev_rate:
        return (False, "no drop")
    rel_drop = (prev_rate - curr_rate) / prev_rate
    curr_lo, curr_hi = wilson_ci(to_curr, from_curr)
    prev_lo, prev_hi = wilson_ci(to_prev, from_prev)
    ci_separated = curr_hi < prev_lo
    if ci_separated and rel_drop >= MDE:
        return (
            True,
            "rel_drop {:.1%} (curr {:.3%} CI[{:.3f},{:.3f}] vs prev {:.3%} CI[{:.3f},{:.3f}])".format(
                rel_drop, curr_rate, curr_lo, curr_hi, prev_rate, prev_lo, prev_hi
            ),
        )
    why = []
    if not ci_separated:
        why.append("Wilson CI overlap")
    if rel_drop < MDE:
        why.append("rel_drop {:.1%} < MDE {:.0%}".format(rel_drop, MDE))
    return (False, "not significant ({})".format("; ".join(why)))


def evaluate_transition(
    from_stage: str, to_stage: str, curr: dict, prev: Optional[dict]
) -> tuple:
    """Run ONE stage transition through Gates 0-2 (Gate 3 persistence is applied
    across cycles by the caller). Returns (status, detail, counts). `counts` is
    ALWAYS populated so the alarm can quote absolute numbers."""
    from_c = stage_count(curr, from_stage)
    to_c = stage_count(curr, to_stage)
    from_p = stage_count(prev, from_stage) if prev else None
    to_p = stage_count(prev, to_stage) if prev else None
    counts = {
        "from": from_stage,
        "to": to_stage,
        "from_curr": from_c,
        "to_curr": to_c,
        "from_prev": from_p,
        "to_prev": to_p,
    }

    # ── Gate 0 — structural-zero / un-captured / un-cleanable upstream ──
    if to_c is None:
        return (NO_DATA, "downstream stage not captured", counts)
    if to_c == 0 and (to_p is None or to_p == 0):
        # e.g. install->mcp_tools_list: 0 both weeks (structurally absent pre-capture).
        return (NO_DATA, "downstream structurally absent (0 both weeks)", counts)
    if from_stage in UNCLEANABLE_UPSTREAM:
        # e.g. install->first_call: npm-download denominator is not behavioral.
        return (NO_DATA, "un-cleanable npm upstream (use by_authenticity)", counts)
    if from_c is None or from_c == 0:
        return (NO_DATA, "no upstream traffic", counts)
    if prev is None or from_p is None or to_p is None or from_p == 0:
        return (NO_DATA, "no comparable previous window", counts)

    # ── Gate 1 — sample floor ──
    if from_c < N_MIN or to_p < C_MIN:
        return (
            INSUFFICIENT_SAMPLE,
            "n={:.0f} (<{}) or baseline_conv={:.0f} (<{})".format(from_c, N_MIN, to_p, C_MIN),
            counts,
        )

    # ── Gate 2 — significance (Wilson CI non-overlap + relative drop >= MDE) ──
    significant, detail = is_significant_drop(to_c, from_c, to_p, from_p)
    if not significant:
        return (OK, detail, counts)
    return (LEAK, detail, counts)


def _by_authenticity_counts(snap: dict) -> Optional[tuple]:
    """Reconstruct (human_with_call, human_denominator) from by_authenticity for the
    cleaned-activation Gate-2 check. None when the field is absent (pre-CH3) or
    incomplete — the check is then skipped (defensive)."""
    ba = snap.get("by_authenticity")
    if not isinstance(ba, dict):
        return None
    human = _num(ba.get("human_denominator"))
    pct = _num(ba.get("human_first_call_pct"))
    if human is None or pct is None or human <= 0:
        return None
    return (round(pct * human), human)


def compute_alert_conditions(
    current: dict, previous: Optional[dict], prev_prev: Optional[dict]
) -> tuple:
    """Decide whether the current snapshot triggers an alert under the 4 gates.

    Returns (alert_should_fire, reasons, statuses) where `statuses` maps every
    transition key -> (status, detail, counts) for the (gate-the-alarm-not-the-data)
    log + body. A LEAK fires ONLY if the SAME transition is also a LEAK in the prior
    cycle (Gate 3 persistence); with only 2 snapshots it is `watching`, not a fire.
    The cooldown is the wrapper's.
    """
    reasons = []
    statuses = {}

    for i in range(1, len(STAGE_ORDER)):
        from_s = STAGE_ORDER[i - 1]
        to_s = STAGE_ORDER[i]
        key = "{}_to_{}".format(from_s, to_s)
        status, detail, counts = evaluate_transition(from_s, to_s, current, previous)
        statuses[key] = (status, detail, counts)
        if status != LEAK:
            continue
        # Gate 3 — persistence: require the PRIOR cycle (previous vs prev_prev) to
        # also be a LEAK. Without a 3rd snapshot we cannot confirm -> watch, don't fire.
        if prev_prev is None:
            statuses[key] = (
                OK,
                "1 down-cycle, watching (need {} consecutive; no prev-prev snapshot)".format(PERSISTENCE),
                counts,
            )
            continue
        prior_status, _prior_detail, _prior_counts = evaluate_transition(from_s, to_s, previous, prev_prev)
        if prior_status == LEAK:
            reasons.append(
                "{}: {} [persistent >= {} cycles]".format(key, detail, PERSISTENCE)
            )
        else:
            statuses[key] = (
                OK,
                "1 down-cycle, watching (prior cycle {})".format(prior_status),
                counts,
            )

    # ── Cleaned-activation check (CH3 by_authenticity), when present in 3 snapshots ──
    cur_ba = _by_authenticity_counts(current)
    prev_ba = _by_authenticity_counts(previous) if previous else None
    pp_ba = _by_authenticity_counts(prev_prev) if prev_prev else None
    if cur_ba and prev_ba:
        c_to, c_from = cur_ba
        p_to, p_from = prev_ba
        if c_from < N_MIN or p_to < C_MIN:
            statuses["by_authenticity.human_first_call_pct"] = (
                INSUFFICIENT_SAMPLE,
                "human_n={:.0f} (<{}) or baseline={:.0f} (<{})".format(c_from, N_MIN, p_to, C_MIN),
                {"to_curr": c_to, "from_curr": c_from, "to_prev": p_to, "from_prev": p_from},
            )
        else:
            sig, detail = is_significant_drop(c_to, c_from, p_to, p_from)
            counts = {"to_curr": c_to, "from_curr": c_from, "to_prev": p_to, "from_prev": p_from}
            if sig and pp_ba:
                pp_to, pp_from = pp_ba
                prior_sig, _ = is_significant_drop(p_to, p_from, pp_to, pp_from)
                if prior_sig:
                    reasons.append(
                        "by_authenticity.human_first_call_pct (cleaned activation): {} [persistent]".format(detail)
                    )
                    statuses["by_authenticity.human_first_call_pct"] = (LEAK, detail, counts)
                else:
                    statuses["by_authenticity.human_first_call_pct"] = (OK, "1 down-cycle, watching", counts)
            else:
                statuses["by_authenticity.human_first_call_pct"] = (
                    LEAK if sig else OK,
                    detail + ("" if pp_ba else " (no prev-prev — watching)") if sig else detail,
                    counts,
                )
                # significant but unconfirmed -> watch, do not add to reasons.

    return (len(reasons) > 0, reasons, statuses)


def _fmt_counts(c: dict) -> str:
    def g(k):
        v = c.get(k)
        return "—" if v is None else "{:.0f}".format(v)
    return "curr {}/{}  prev {}/{}".format(g("to_curr"), g("from_curr"), g("to_prev"), g("from_prev"))


def format_alert_body(
    current: dict,
    previous: Optional[dict],
    reasons: list,
    statuses: dict,
    snapshots_used: list,
) -> str:
    """Compose the Telegram alert body per the operator-action-required contract.
    Always quotes ABSOLUTE counts for every fired reason (gate the alarm, not the
    data). Recommended-wave template stays in `{NEXT}` form."""
    snapshot_window = current.get("window") or {}
    window_from = snapshot_window.get("from", "?")
    window_to = snapshot_window.get("to", "?")

    reasons_block = "\n".join("  - {}".format(r) for r in reasons) if reasons else "  - (none)"

    # Absolute-count appendix for the fired transitions (+ any suppressed-but-notable).
    counts_lines = []
    for key, (status, detail, counts) in statuses.items():
        if status in (LEAK, INSUFFICIENT_SAMPLE):
            counts_lines.append("  {} [{}] {}".format(key, status, _fmt_counts(counts)))
    counts_block = "\n".join(counts_lines) if counts_lines else "  (no sampled transitions)"

    return (
        "🛑 {}\n".format(ALERT_ID)
        + "Window: {} → {}\n".format(window_from, window_to)
        + "\nTrigger reasons (4-gate guard — significant + persistent only):\n{}\n".format(reasons_block)
        + "\nAbsolute counts:\n{}\n".format(counts_block)
        + "\nAction: dispatch {} via Cowork → Claude Code\n".format(WAVE_TEMPLATE)
        + "Audit shape: {}\n".format(AUDIT_DOC)
        + "Snapshots compared: {}\n".format(", ".join(snapshots_used))
    )


def invoke_wrapper(wrapper_path: Path, body: str) -> int:
    """Pipe-subprocess invoke the canonical send_telegram.sh wrapper. The wrapper
    owns severity-gate, COOLDOWN-gate, env-load, fail-open, and template-resolver —
    zero re-implementation here."""
    try:
        result = subprocess.run(
            [str(wrapper_path), ALERT_ID, "CRITICAL_PERSISTENT", "-"],
            input=body,
            encoding="utf-8",
            timeout=15,
            check=False,
        )
        return result.returncode
    except Exception as e:  # noqa: BLE001 — fail-open: log + non-zero, never raise.
        log("wrapper invocation failed: {}".format(e))
        return 1


def main() -> int:
    snapshots_dir = Path(os.environ.get("SNAPSHOTS_DIR", DEFAULT_SNAPSHOTS_DIR))
    wrapper_path = Path(os.environ.get("WRAPPER_PATH", DEFAULT_WRAPPER_PATH))
    dry_run_autopilot = os.environ.get("DRY_RUN_AUTOPILOT") == "1"

    try:
        snapshots = list_snapshots(snapshots_dir)
    except FileNotFoundError as e:
        log("FATAL: {}".format(e))
        return 1

    if not snapshots:
        log("no -auto.json snapshots found in {} — nothing to compare".format(snapshots_dir))
        return 0

    # Persistence (Gate 3) compares TWO consecutive WoW cycles → load up to 3 snapshots.
    current_path = snapshots[-1]
    previous_path = snapshots[-2] if len(snapshots) >= 2 else None
    prev_prev_path = snapshots[-3] if len(snapshots) >= 3 else None
    log(
        "comparing current={} vs previous={} vs prev_prev={}".format(
            current_path.name,
            previous_path.name if previous_path else "<none>",
            prev_prev_path.name if prev_prev_path else "<none>",
        )
    )

    try:
        current = load_snapshot(current_path)
    except Exception as e:  # noqa: BLE001
        log("FATAL: failed to load current snapshot {}: {}".format(current_path, e))
        return 1

    previous = None
    if previous_path is not None:
        try:
            previous = load_snapshot(previous_path)
        except Exception as e:  # noqa: BLE001
            log("WARN: failed to load previous snapshot {}: {}".format(previous_path, e))
    prev_prev = None
    if prev_prev_path is not None:
        try:
            prev_prev = load_snapshot(prev_prev_path)
        except Exception as e:  # noqa: BLE001
            log("WARN: failed to load prev_prev snapshot {}: {}".format(prev_prev_path, e))

    snapshots_used = [current_path.name]
    if previous is not None:
        snapshots_used.append(previous_path.name)
    if prev_prev is not None:
        snapshots_used.append(prev_prev_path.name)

    should_fire, reasons, statuses = compute_alert_conditions(current, previous, prev_prev)

    # Always log the per-transition gate verdicts (the data is never hidden).
    for key, (status, detail, _counts) in statuses.items():
        if status != OK:
            log("gate[{}] = {} :: {}".format(key, status, detail))

    if not should_fire:
        log("no significant + persistent leak — silent exit (gates suppressed any artifacts)")
        return 0

    body = format_alert_body(current, previous, reasons, statuses, snapshots_used)
    log("alert conditions met ({} reason(s)); preparing wrapper invocation".format(len(reasons)))
    log("reasons: {}".format(reasons))

    if dry_run_autopilot:
        log("DRY_RUN_AUTOPILOT=1 — emitting body to stdout WITHOUT wrapper invocation")
        print(body)
        return 0

    rc = invoke_wrapper(wrapper_path, body)
    log("wrapper exit code: {}".format(rc))
    return rc


if __name__ == "__main__":
    sys.exit(main())

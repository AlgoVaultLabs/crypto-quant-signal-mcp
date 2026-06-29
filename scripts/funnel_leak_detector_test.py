#!/usr/bin/env python3
"""
OPS-ACTIVATION-LEAK-FIX-W1 CH4 — standalone test for the 4-gate funnel-leak
detector. No pytest dependency (the host + local py3.9 have none): plain asserts,
exit 0 (all pass) / 1 (any fail). Loads the hyphenated detector module via
importlib.

Run:  python3 scripts/funnel_leak_detector_test.py
Gate: also accepts the spec's loose flags (--replay A B / --positive-control /
      --expect* ) and runs the SAME full suite regardless.

The key gate (CH4 AC): offline replay of the REAL 2026-06-22 / 2026-06-29
snapshots must NOT fire (the two artifacts are suppressed by Gate 0 / Gate 1),
and a synthetic well-sampled persistent drop MUST fire (Gate 2 + Gate 3) —
proving the guard isn't blind.
"""
from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DETECTOR = REPO / "audits" / "ACTIVATION-FUNNEL-AUDIT-W1-funnel-leak-detector.py"
SNAPS = REPO / "activation-funnel" / "snapshots"

_spec = importlib.util.spec_from_file_location("funnel_leak_detector", str(DETECTOR))
det = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(det)

_failures = []


def check(cond: bool, label: str) -> None:
    status = "PASS" if cond else "FAIL"
    if not cond:
        _failures.append(label)
    print("[{}] {}".format(status, label))


# ── Helpers ──

def mk_snap(funnel_overrides: dict, by_authenticity=None) -> dict:
    funnel = {s: 0 for s in det.STAGE_ORDER}
    funnel.update(funnel_overrides)
    snap = {"window": {"from": "2099-01-01T00:00:00Z", "to": "2099-01-08T00:00:00Z"}, "funnel": funnel}
    if by_authenticity is not None:
        snap["by_authenticity"] = by_authenticity
    return snap


# ── Unit: Wilson CI ──

def test_wilson():
    lo, hi = det.wilson_ci(0, 100)
    check(lo < 1e-6 and 0.0 < hi < 0.1, "wilson_ci(0,100): lo~=0, small hi ({:.4f},{:.4f})".format(lo, hi))
    lo, hi = det.wilson_ci(50, 100)
    check(0.39 < lo < 0.5 < hi < 0.61, "wilson_ci(50,100) ~centered on 0.5 ({:.4f},{:.4f})".format(lo, hi))
    lo, hi = det.wilson_ci(5, 5)
    check(hi == 1.0 and lo < 1.0, "wilson_ci(5,5): hi clamps to 1.0")
    lo, hi = det.wilson_ci(1, 0)
    check(lo == 0.0 and hi == 1.0, "wilson_ci(x,0): widest interval (no info)")


# ── Unit: Gate 2 significance (+ MDE boundary with exact-dividing integers) ──

def test_significance():
    # AC numbers: 200/2000 vs 800/2000 — a huge, well-sampled, CI-separated drop.
    sig, _ = det.is_significant_drop(200, 2000, 800, 2000)
    check(sig is True, "is_significant_drop(200/2000 vs 800/2000) FIRES (Gate 2)")
    # No drop → not significant.
    sig, _ = det.is_significant_drop(820, 2000, 800, 2000)
    check(sig is False, "is_significant_drop on an INCREASE → not significant")
    # Tiny drop, CI overlap → not significant.
    sig, _ = det.is_significant_drop(790, 2000, 800, 2000)
    check(sig is False, "is_significant_drop tiny drop (790 vs 800 /2000) → not significant")
    # MDE BOUNDARY (floating-point-boundary skill: integers that divide EXACTLY).
    # 560/2000 = 0.28, 800/2000 = 0.40 → rel drop = 0.12/0.40 = 0.30 == MDE, CI-separated.
    sig, _ = det.is_significant_drop(560, 2000, 800, 2000)
    check(sig is True, "is_significant_drop at EXACTLY MDE=30% rel drop (560/2000 vs 800/2000) FIRES")
    # 568/2000 = 0.284 → rel drop = 0.116/0.40 = 0.29 < MDE → suppressed even though CI-separated.
    sig, _ = det.is_significant_drop(568, 2000, 800, 2000)
    check(sig is False, "is_significant_drop just BELOW MDE (29% rel drop) suppressed by MDE floor")


# ── Unit: per-transition gate routing ──

def test_transition_gates():
    # install upstream → un-cleanable npm denominator → NO_DATA even with a big drop.
    st, _, _ = det.evaluate_transition("install", "first_call", mk_snap({"install": 1113, "first_call": 279}), mk_snap({"install": 740, "first_call": 620}))
    check(st == det.NO_DATA, "evaluate install→first_call → NO_DATA (un-cleanable npm upstream)")
    # downstream 0 both weeks → structurally absent → NO_DATA.
    st, _, _ = det.evaluate_transition("install", "mcp_tools_list", mk_snap({"install": 1113, "mcp_tools_list": 0}), mk_snap({"install": 740, "mcp_tools_list": 0}))
    check(st == det.NO_DATA, "evaluate install→mcp_tools_list (0 both weeks) → NO_DATA")
    # tiny sample → INSUFFICIENT_SAMPLE.
    st, _, _ = det.evaluate_transition("tg_bot_start", "tg_bot_first_command", mk_snap({"tg_bot_start": 7, "tg_bot_first_command": 0}), mk_snap({"tg_bot_start": 7, "tg_bot_first_command": 2}))
    check(st == det.INSUFFICIENT_SAMPLE, "evaluate tg_bot_start→tg_bot_first_command (n=7) → INSUFFICIENT_SAMPLE")
    # well-sampled significant drop → LEAK (Gate 2 level).
    st, _, _ = det.evaluate_transition("first_call", "quota_hit_soft", mk_snap({"first_call": 2000, "quota_hit_soft": 200}), mk_snap({"first_call": 2000, "quota_hit_soft": 800}))
    check(st == det.LEAK, "evaluate first_call→quota_hit_soft (200 vs 800 /2000) → LEAK (Gate 2)")


# ── Integration: offline replay of the REAL snapshots → NO FIRE ──

def test_offline_replay():
    s0629 = det.load_snapshot(SNAPS / "2026-06-29-auto.json")
    s0622 = det.load_snapshot(SNAPS / "2026-06-22-auto.json")
    s0615 = det.load_snapshot(SNAPS / "2026-06-15-auto.json")

    # 2-snapshot replay (current vs previous, no prev_prev).
    fire2, reasons2, statuses2 = det.compute_alert_conditions(s0629, s0622, None)
    check(fire2 is False, "offline replay (06-29 vs 06-22) → NO FIRE")
    check(statuses2["install_to_mcp_tools_list"][0] == det.NO_DATA, "  install→mcp_tools_list → NO_DATA (Gate 0)")
    check(statuses2["tg_bot_start_to_tg_bot_first_command"][0] == det.INSUFFICIENT_SAMPLE, "  tg_bot_start→tg_bot_first_command → INSUFFICIENT_SAMPLE (Gate 1)")
    # The adjacent transition that DOES touch the artifact (mcp_tools_list=0 upstream) → NO_DATA.
    check(statuses2["mcp_tools_list_to_first_call"][0] == det.NO_DATA, "  mcp_tools_list→first_call (0 upstream) → NO_DATA (Gate 0)")
    # The polluted-but-real install→first_call 84%→25% drop is a `conversion` RATIO, not an
    # adjacent stage transition — the new detector RETIRES the old install_to_first_call FLOOR
    # (npm un-cleanable, Q2) so it is no longer checked → can't false-fire. No reason names it.
    check(not any("install" in r and "first_call" in r for r in reasons2), "  install→first_call conversion drop is NOT a fired reason (floor retired)")

    # 3-snapshot replay (persistence available) — gates STILL suppress the artifacts.
    fire3, reasons3, statuses3 = det.compute_alert_conditions(s0629, s0622, s0615)
    check(fire3 is False, "offline replay with persistence (06-15/06-22/06-29) → STILL NO FIRE")


# ── Integration: positive control — a real, well-sampled, PERSISTENT drop → FIRES ──

def test_positive_control():
    pp = mk_snap({"first_call": 2000, "quota_hit_soft": 800})    # rate 0.40
    prev = mk_snap({"first_call": 2000, "quota_hit_soft": 320})  # rate 0.16 (drop from pp)
    curr = mk_snap({"first_call": 2000, "quota_hit_soft": 120})  # rate 0.06 (drop from prev)
    fire, reasons, statuses = det.compute_alert_conditions(curr, prev, pp)
    check(fire is True, "positive control: persistent well-sampled drop → FIRES (Gate 2 + Gate 3)")
    check(any("first_call_to_quota_hit_soft" in r for r in reasons), "  fired reason names the leaking transition")
    # Single down-cycle (no prev_prev) → watching, NOT a fire (persistence gate).
    fire1, _, _ = det.compute_alert_conditions(curr, prev, None)
    check(fire1 is False, "single down-cycle (no prev_prev) → watching, NOT a fire (Gate 3)")


# ── Integration: by_authenticity cleaned-activation path fires when present ──

def test_cleaned_activation():
    ba_hi = {"raw_denominator": 700, "human_denominator": 500, "automated_count": 200, "human_first_call_pct": 0.40}
    ba_mid = {"raw_denominator": 700, "human_denominator": 500, "automated_count": 200, "human_first_call_pct": 0.16}
    ba_lo = {"raw_denominator": 700, "human_denominator": 500, "automated_count": 200, "human_first_call_pct": 0.06}
    pp = mk_snap({}, by_authenticity=ba_hi)
    prev = mk_snap({}, by_authenticity=ba_mid)
    curr = mk_snap({}, by_authenticity=ba_lo)
    fire, reasons, statuses = det.compute_alert_conditions(curr, prev, pp)
    check(fire is True, "cleaned by_authenticity activation: persistent drop → FIRES")
    check(any("by_authenticity" in r for r in reasons), "  fired reason is the cleaned-activation signal")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--replay", nargs="*", default=None)
    ap.add_argument("--positive-control", action="store_true")
    ap.add_argument("--expect", default=None)
    ap.add_argument("--expect-fire", action="store_true")
    ap.parse_known_args()  # accept the spec's loose flags; the full suite runs regardless.

    print("=== OPS-ACTIVATION-LEAK-FIX-W1 CH4 detector test ===")
    print("detector: {}".format(DETECTOR.name))
    test_wilson()
    test_significance()
    test_transition_gates()
    test_offline_replay()
    test_positive_control()
    test_cleaned_activation()

    print("---")
    if _failures:
        print("FAILED ({}): {}".format(len(_failures), "; ".join(_failures)))
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())

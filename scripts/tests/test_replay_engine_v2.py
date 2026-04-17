#!/usr/bin/env python3
"""Unit tests for the Mode A v2 replay engine (trail variants).

Run from repo root:
    python3 -m unittest scripts.tests.test_replay_engine_v2
"""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from backtest_hl_lanes_mode_a import Candle, Signal  # noqa: E402
from backtest_hl_lanes_mode_a_v2 import replay_variant  # noqa: E402


RECIPE_5M = {
    "stopLossPct": 0.01,
    "tp1Pct": 0.005,
    "tp2Pct": 0.01,        # V0/V2 tp2
    "maxHoldCandles": 5,
    "tp1Fraction": 0.5,
    "moveSlToBeAfterTp1": True,
    "minConfidence": 52,
    "tf_seconds": 300,
}

V0_SPEC = {"tp2Pct": 0.01,  "exit_mode": "scale_out_be",    "trail_pct": 0.0}
V1_SPEC = {"tp2Pct": 0.015, "exit_mode": "scale_out_be",    "trail_pct": 0.0}   # wider TP2
V2_SPEC = {"tp2Pct": 0.01,  "exit_mode": "scale_out_trail", "trail_pct": 0.005}
V3_SPEC = {"tp2Pct": 0.015, "exit_mode": "scale_out_trail", "trail_pct": 0.005}


def _signal(direction="BUY", entry=100.0, ts=1_776_000_000, tf="5m", confidence=70):
    return Signal(
        signal_id=1, coin="BTC", direction=direction, entry_price=entry,
        confidence=confidence, created_at=ts, timeframe=tf,
        pfe_return_pct=None, mae_pct=None, regime=None,
    )


def _bar(mm, o, h, l, c, base_ts=1_776_000_000):
    return Candle(t_ms=(base_ts + mm * 60) * 1000, o=o, h=h, l=l, c=c)


class V2TrailReplayTests(unittest.TestCase):
    """Covers trail-mode exit branches. BE-mode branches are already proven by
    the v1 test suite (and V0 regression against v1 rows)."""

    def test_v2_trail_exits_on_peak_retrace_long(self):
        """After TP1 fills at 100.5, price rises to peak 100.9 then retraces.
        Peak × (1 − 0.005) = 100.9 × 0.995 = 100.3955. max(entry=100, 100.3955)
        = 100.3955 → trail level. Bar 2 wicks low to 100.3 < 100.3955 → trail
        exits runner at 100.3955. Runner PnL = 0.003955. Blended = 0.5 × 0.005
        + 0.5 × 0.003955 = 0.0044775.
        """
        sig = _signal("BUY", 100.0)
        bars = [
            _bar(0, 100.0, 100.6, 99.9, 100.5),   # TP1 fills
            _bar(1, 100.5, 100.9, 100.5, 100.8),  # peak → 100.9
            _bar(2, 100.8, 100.85, 100.3, 100.4), # low 100.3 < trail 100.3955 → exit
        ]
        out = replay_variant(sig, bars, RECIPE_5M, V2_SPEC)
        self.assertEqual(out.outcome_type, "TP1_TRAIL")
        self.assertAlmostEqual(out.realized_pnl_pct, 0.0044775, places=6)
        self.assertIsNotNone(out.tp1_hit_ts)

    def test_v2_trail_falls_back_to_be_if_peak_barely_moves_long(self):
        """If peak after TP1 never climbs above entry × 1/(1-trail) = 100.503,
        then max(entry, peak×0.995) = entry (= BE). A retrace to entry stops
        out the runner at BE. Runner PnL = 0. Blended = 0.5 × 0.005 = 0.0025.
        """
        sig = _signal("BUY", 100.0)
        bars = [
            _bar(0, 100.0, 100.5, 99.9, 100.4),   # TP1 at 100.5 (high=100.5)
            _bar(1, 100.4, 100.5, 99.8, 99.9),    # peak stays at 100.5; low 99.8 < entry 100
        ]
        out = replay_variant(sig, bars, RECIPE_5M, V2_SPEC)
        self.assertEqual(out.outcome_type, "TP1_TRAIL")
        self.assertAlmostEqual(out.realized_pnl_pct, 0.0025, places=6)

    def test_v2_trail_hits_tp2_before_retrace_long(self):
        """Peak keeps rising past TP2 (1%) before any retrace. Exit at TP2.
        Runner PnL = 0.01. Blended = 0.5 × 0.005 + 0.5 × 0.01 = 0.0075.
        """
        sig = _signal("BUY", 100.0)
        bars = [
            _bar(0, 100.0, 100.5, 99.9, 100.5),  # TP1
            _bar(1, 100.5, 101.1, 100.5, 101.0), # TP2 at 101
        ]
        out = replay_variant(sig, bars, RECIPE_5M, V2_SPEC)
        self.assertEqual(out.outcome_type, "TP1_TP2")
        self.assertAlmostEqual(out.realized_pnl_pct, 0.0075, places=6)

    def test_v2_trail_time_exit_long_positive(self):
        """After TP1, runner grinds up but never hits TP2 or trail. Time exit
        at last close. Runner PnL = (last_close − entry) / entry.
        Last close 100.6 → runner = 0.006. Blended = 0.5 × 0.005 + 0.5 × 0.006
        = 0.0055.
        """
        sig = _signal("BUY", 100.0)
        bars = [
            _bar(0, 100.0, 100.5, 99.9, 100.4),   # TP1
            _bar(1, 100.4, 100.6, 100.3, 100.5),
            _bar(2, 100.5, 100.7, 100.4, 100.6),
            _bar(3, 100.6, 100.7, 100.5, 100.6),
            _bar(4, 100.6, 100.65, 100.55, 100.6),
            _bar(5, 100.6, 100.65, 100.55, 100.6),  # beyond max hold = 5 → still include bar index 4
        ]
        out = replay_variant(sig, bars, RECIPE_5M, V2_SPEC)
        # With maxHoldCandles=5 and tf=300s, cutoff is t0 + 1500s. Bar 5 is at
        # t0+300s (minute 5), still within. But our time-loop compares bar.t_ms
        # to the cutoff, and the 6th bar (index 5) is at created_at+300s — still
        # within the 1500s window if bars are at 1-min spacing. Expect TP1_TIME.
        self.assertEqual(out.outcome_type, "TP1_TIME")
        # runner_pnl = (100.6 - 100) / 100 = 0.006
        self.assertAlmostEqual(out.realized_pnl_pct, 0.0025 + 0.5 * 0.006, places=6)

    def test_v2_trail_short_mirror(self):
        """SELL mirror: favorable = price down. TP1=99.5. Peak (=low) tracks
        DOWN. Trail level = min(entry, peak × (1 + trail)). A retrace UP past
        trail exits the runner at trail."""
        sig = _signal("SELL", 100.0)
        bars = [
            _bar(0, 100.0, 100.1, 99.4, 99.5),   # TP1 low=99.4
            _bar(1, 99.5, 99.7, 99.1, 99.2),     # peak = 99.1 → trail = min(100, 99.1 * 1.005) = 99.5955
            _bar(2, 99.2, 99.65, 99.15, 99.6),   # high 99.65 ≥ trail 99.5955 → exit at 99.5955
        ]
        out = replay_variant(sig, bars, RECIPE_5M, V2_SPEC)
        self.assertEqual(out.outcome_type, "TP1_TRAIL")
        # TP1 leg = 0.005 * 0.5 = 0.0025
        # Runner: entry 100, trail 99.5955 → runner_pnl = (100 - 99.5955)/100 = 0.004045
        # Blended = 0.0025 + 0.5 * 0.004045 = 0.0045225
        self.assertAlmostEqual(out.realized_pnl_pct, 0.0045225, places=6)

    def test_v3_combined_wider_tp2_hit_long(self):
        """V3 = V1 (widen TP2 to 0.015) + V2 (trail). Peak grinds up through
        TP2=101.5 without retracing past the trail. TP2 hits first on the
        ascent. Expect TP1_TP2."""
        sig = _signal("BUY", 100.0)
        bars = [
            _bar(0, 100.0, 100.5, 99.9, 100.5),
            _bar(1, 100.5, 101.0, 100.6, 100.9),   # low 100.6 > trail 100.495 (no trail)
            _bar(2, 100.9, 101.6, 100.8, 101.5),   # hits 101.5 (tp2); low 100.8 < trail 101.092 but TP2 priority
        ]
        out = replay_variant(sig, bars, RECIPE_5M, V3_SPEC)
        self.assertEqual(out.outcome_type, "TP1_TP2")
        # Blended = 0.5 * 0.005 + 0.5 * 0.015 = 0.01
        self.assertAlmostEqual(out.realized_pnl_pct, 0.01, places=6)

    def test_v2_sl_before_tp1_still_SL(self):
        """Phase 1 is unchanged — if SL hits before TP1, outcome = SL even in
        trail mode."""
        sig = _signal("BUY", 100.0)
        bars = [
            _bar(0, 100.0, 100.2, 98.9, 99.5),  # low 98.9 ≤ SL 99
        ]
        out = replay_variant(sig, bars, RECIPE_5M, V2_SPEC)
        self.assertEqual(out.outcome_type, "SL")
        self.assertAlmostEqual(out.realized_pnl_pct, -0.01, places=6)

    def test_v0_delegates_to_v1_replay(self):
        """V0 exit_mode='scale_out_be' must go through v1.replay_signal (not
        our trail walker). Use a clean TP1+TP2 fixture and verify the outcome."""
        sig = _signal("BUY", 100.0)
        bars = [
            _bar(0, 100.0, 100.4, 99.9, 100.3),
            _bar(1, 100.3, 100.6, 100.2, 100.5),
            _bar(2, 100.5, 101.1, 100.4, 101.0),
        ]
        out = replay_variant(sig, bars, RECIPE_5M, V0_SPEC)
        self.assertEqual(out.outcome_type, "TP1_TP2")
        self.assertAlmostEqual(out.realized_pnl_pct, 0.0075, places=6)


if __name__ == "__main__":
    unittest.main()
